// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

// APP-010 leftover: accepted local-files bind persists in localStorage
// so Home dataset facts survive relaunch. Never Dexie recipes.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { installLocalStorageFake } from "./helpers/kit.ts";
import {
  acceptLocalFilesProposal,
  proposeLocalFiles,
} from "../src/features/data-recipes/data/local-files-proposal.ts";
import {
  bindAcceptedLocalFilesToHome,
  clearAcceptedLocalFilesFromHome,
  getAcceptedLocalDatasetBind,
  getAcceptedLocalDatasetPath,
  hydrateAcceptedLocalDatasetBind,
  HOME_DATASET_BIND_STORAGE_KEY,
} from "../src/features/data-recipes/data/local-files-home-bind.ts";
import { buildOutcomePlan } from "../src/features/home/outcome-plan-builder.ts";
import { CLI007_RETAINED } from "../src/features/compare/retained-adapter-bind.ts";
import {
  isRuntimeAdmitted,
  receipt,
} from "../src/features/home/mlx-runtime-admission.ts";

const { store: localStorageStore, storage } = installLocalStorageFake();

function ref(path: string, bytes: number) {
  return { path, bytes };
}

function storedBind(): unknown {
  const raw = storage.getItem(HOME_DATASET_BIND_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function resetBindSurface(): void {
  localStorageStore.delete(HOME_DATASET_BIND_STORAGE_KEY);
  clearAcceptedLocalFilesFromHome();
}

test("accept bind seeds Home dataset and persists {path,hash,authority:false}", async () => {
  resetBindSurface();
  const proposal = await proposeLocalFiles({
    files: [ref("./train.jsonl", 12)],
  });
  const accepted = acceptLocalFilesProposal(proposal);
  const bind = bindAcceptedLocalFilesToHome(accepted);
  assert.equal(bind?.path, "./train.jsonl");
  assert.equal(bind?.authority, false);
  assert.equal(getAcceptedLocalDatasetPath(), "./train.jsonl");
  assert.deepEqual(storedBind(), {
    path: "./train.jsonl",
    hash: accepted.hash,
    authority: false,
  });
});

async function importBindFresh(tag: string) {
  const href = new URL(
    "../src/features/data-recipes/data/local-files-home-bind.ts",
    import.meta.url,
  );
  href.searchParams.set("reset", tag);
  return import(href.href);
}

test("hydrate after reset-module sees persisted path", async () => {
  resetBindSurface();
  const proposal = await proposeLocalFiles({
    files: [ref("./train.jsonl", 12)],
  });
  bindAcceptedLocalFilesToHome(acceptLocalFilesProposal(proposal));
  const fresh = await importBindFresh(`reset-module-${Date.now()}`);
  assert.equal(fresh.getAcceptedLocalDatasetPath(), "./train.jsonl");
  assert.equal(fresh.getAcceptedLocalDatasetBind()?.authority, false);
});

test("hydrate after reload restores the persisted local bind", async () => {
  resetBindSurface();
  const proposal = await proposeLocalFiles({
    files: [ref("./train.jsonl", 12)],
  });
  const accepted = acceptLocalFilesProposal(proposal);
  bindAcceptedLocalFilesToHome(accepted);
  const persisted = storedBind();
  assert.ok(persisted);

  // Simulate relaunch: drop memory only, keep the store, then hydrate.
  clearAcceptedLocalFilesFromHome();
  assert.equal(getAcceptedLocalDatasetPath(), null);
  storage.setItem(HOME_DATASET_BIND_STORAGE_KEY, JSON.stringify(persisted));
  const hydrated = hydrateAcceptedLocalDatasetBind();
  assert.equal(hydrated?.path, "./train.jsonl");
  assert.equal(hydrated?.hash, accepted.hash);
  assert.equal(hydrated?.authority, false);
  assert.equal(getAcceptedLocalDatasetPath(), "./train.jsonl");
  assert.deepEqual(getAcceptedLocalDatasetBind(), {
    path: "./train.jsonl",
    hash: accepted.hash,
    authority: false,
  });
});

test("proposed (not accepted) bind does not seed dataset or store", async () => {
  resetBindSurface();
  const proposal = await proposeLocalFiles({
    files: [ref("./train.jsonl", 12)],
  });
  assert.equal(bindAcceptedLocalFilesToHome(proposal), null);
  assert.equal(getAcceptedLocalDatasetPath(), null);
  assert.equal(storedBind(), null);
});

test("reject / clear drops the Home dataset fact and the store", async () => {
  resetBindSurface();
  const proposal = await proposeLocalFiles({
    files: [ref("./train.jsonl", 12)],
  });
  bindAcceptedLocalFilesToHome(acceptLocalFilesProposal(proposal));
  assert.ok(storedBind());
  clearAcceptedLocalFilesFromHome();
  assert.equal(getAcceptedLocalDatasetPath(), null);
  assert.equal(getAcceptedLocalDatasetBind(), null);
  assert.equal(storedBind(), null);
});

test("remote and Hub ids are refused and never persisted", async () => {
  resetBindSurface();
  const remotes = [
    "https://huggingface.co/datasets/foo/bar",
    "hf://datasets/foo/bar",
    "hub://foo/bar",
    "mlx-community/Qwen2.5-0.5B",
  ];
  for (const path of remotes) {
    const bind = bindAcceptedLocalFilesToHome({
      id: "local-files:remote",
      hash: "abc123",
      files: [{ path, bytes: 1 }],
      status: "accepted",
      recipeFieldLabel: null,
      authority: false,
      createdAt: 1,
      updatedAt: 1,
    });
    assert.equal(bind, null, `must refuse ${path}`);
    assert.equal(getAcceptedLocalDatasetPath(), null, `memory must stay null for ${path}`);
    assert.equal(storedBind(), null, `store must stay empty for ${path}`);
  }
});

test("invalid store fail-closes to null and clears the key", () => {
  const cases: unknown[] = [
    "not-json",
    12,
    null,
    {},
    { path: "./train.jsonl", hash: "abc" },
    { path: "./train.jsonl", hash: "abc", authority: true },
    { path: "./train.jsonl", hash: "abc", authority: "false" },
    { path: "", hash: "abc", authority: false },
    { path: "./train.jsonl", hash: "", authority: false },
    { path: "https://huggingface.co/foo/bar", hash: "abc", authority: false },
    { path: "mlx-community/Qwen2.5-0.5B", hash: "abc", authority: false },
  ];
  for (const value of cases) {
    resetBindSurface();
    storage.setItem(
      HOME_DATASET_BIND_STORAGE_KEY,
      typeof value === "string" ? value : JSON.stringify(value),
    );
    const hydrated = hydrateAcceptedLocalDatasetBind();
    assert.equal(hydrated, null, `must fail-close ${JSON.stringify(value)}`);
    assert.equal(getAcceptedLocalDatasetPath(), null);
    assert.equal(
      storage.getItem(HOME_DATASET_BIND_STORAGE_KEY),
      null,
      `must clear store for ${JSON.stringify(value)}`,
    );
  }
});

test("bind / hydrate never flip runtimeAdmitted", async () => {
  resetBindSurface();
  const before = isRuntimeAdmitted(receipt);
  const proposal = await proposeLocalFiles({
    files: [ref("./train.jsonl", 12)],
  });
  bindAcceptedLocalFilesToHome(acceptLocalFilesProposal(proposal));
  assert.equal(isRuntimeAdmitted(receipt), before);
  hydrateAcceptedLocalDatasetBind();
  assert.equal(isRuntimeAdmitted(receipt), before);
  clearAcceptedLocalFilesFromHome();
  assert.equal(isRuntimeAdmitted(receipt), before);
  const bindSrc = await readFile(
    new URL(
      "../src/features/data-recipes/data/local-files-home-bind.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(!/runtimeAdmitted\s*[:=]/.test(bindSrc));
});

test("one prompt with accepted dataset still HOLD on admit", () => {
  const card = buildOutcomePlan("Fine-tune a local LoRA", {
    parent: CLI007_RETAINED.parentSnapshotDir,
    dataset: "./train.jsonl",
    runtimeAdmitted: false,
  });
  assert.equal(card.dataset, "./train.jsonl");
  assert.equal(card.authority, false);
  assert.equal(card.action_taken, false);
  const ids = card.clarifications.map((c) =>
    typeof c === "string" ? c : (c as { id?: string }).id,
  );
  assert.ok(
    ids.some((id) => id === "missing-admit" || String(id).includes("admit")),
    `admit clarification must still fire, got ${JSON.stringify(ids)}`,
  );
});

test("log proof: hydrated dataset + ADMITTED receipt clears missing-dataset and missing-admit; clear still fires missing-dataset", async () => {
  resetBindSurface();
  assert.equal(isRuntimeAdmitted(receipt), true, "live receipt must be ADMITTED");
  const proposal = await proposeLocalFiles({
    files: [ref("./train.jsonl", 12)],
  });
  const accepted = acceptLocalFilesProposal(proposal);
  bindAcceptedLocalFilesToHome(accepted);
  const persisted = storedBind();
  clearAcceptedLocalFilesFromHome();
  storage.setItem(HOME_DATASET_BIND_STORAGE_KEY, JSON.stringify(persisted));
  hydrateAcceptedLocalDatasetBind();

  const ready = buildOutcomePlan("Fine-tune a local LoRA", {
    parent: CLI007_RETAINED.parentSnapshotDir,
    dataset: getAcceptedLocalDatasetPath(),
    runtimeAdmitted: isRuntimeAdmitted(receipt),
  });
  assert.equal(ready.dataset, "./train.jsonl");
  assert.equal(ready.clarifications.includes("missing-dataset"), false);
  assert.equal(ready.clarifications.includes("missing-admit"), false);

  clearAcceptedLocalFilesFromHome();
  const cleared = buildOutcomePlan("Fine-tune a local LoRA", {
    parent: CLI007_RETAINED.parentSnapshotDir,
    dataset: getAcceptedLocalDatasetPath(),
    runtimeAdmitted: isRuntimeAdmitted(receipt),
  });
  assert.equal(getAcceptedLocalDatasetPath(), null);
  assert.equal(cleared.clarifications.includes("missing-dataset"), true);
  assert.equal(cleared.clarifications.includes("missing-admit"), false);
});

test("page Accept writes the home bind; composer reads it; admit stays derived", async () => {
  const page = await readFile(
    new URL(
      "../src/features/data-recipes/pages/data-recipes-page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const composer = await readFile(
    new URL("../src/features/home/home-composer.tsx", import.meta.url),
    "utf8",
  );
  const bindSrc = await readFile(
    new URL(
      "../src/features/data-recipes/data/local-files-home-bind.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(page.includes("bindAcceptedLocalFilesToHome"));
  assert.ok(page.includes("clearAcceptedLocalFilesFromHome"));
  assert.ok(composer.includes("getAcceptedLocalDatasetPath"));
  assert.ok(composer.includes("isRuntimeAdmitted(receipt)"));
  assert.ok(!/runtimeAdmitted:\s*true/.test(composer));
  assert.ok(!/createRecipeDraft/.test(page.slice(page.indexOf("function acceptLocalFiles"))));
  assert.ok(bindSrc.includes("studiotune.home.dataset-bind.v1"));
  assert.ok(bindSrc.includes("hydrateAcceptedLocalDatasetBind"));
  assert.ok(!bindSrc.includes("createRecipe"));
  assert.ok(!bindSrc.includes("from \"./recipes-db"));
  assert.ok(!/createRecipeDraft|saveRecipe/.test(bindSrc));
});
