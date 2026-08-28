// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

// APP-009 leftover: accepted APP-010 local files seed Home dataset in-memory.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  acceptLocalFilesProposal,
  proposeLocalFiles,
} from "../src/features/data-recipes/data/local-files-proposal.ts";
import {
  bindAcceptedLocalFilesToHome,
  clearAcceptedLocalFilesFromHome,
  getAcceptedLocalDatasetPath,
} from "../src/features/data-recipes/data/local-files-home-bind.ts";
import { buildOutcomePlan } from "../src/features/home/outcome-plan-builder.ts";
import { CLI007_RETAINED } from "../src/features/compare/retained-adapter-bind.ts";

function ref(path: string, bytes: number) {
  return { path, bytes };
}

test("accept bind seeds Home dataset from the first local file path", async () => {
  clearAcceptedLocalFilesFromHome();
  const proposal = await proposeLocalFiles({
    files: [ref("./train.jsonl", 12)],
  });
  const accepted = acceptLocalFilesProposal(proposal);
  const bind = bindAcceptedLocalFilesToHome(accepted);
  assert.equal(bind?.path, "./train.jsonl");
  assert.equal(bind?.authority, false);
  assert.equal(getAcceptedLocalDatasetPath(), "./train.jsonl");
});

test("proposed (not accepted) bind does not seed dataset", async () => {
  clearAcceptedLocalFilesFromHome();
  const proposal = await proposeLocalFiles({
    files: [ref("./train.jsonl", 12)],
  });
  assert.equal(bindAcceptedLocalFilesToHome(proposal), null);
  assert.equal(getAcceptedLocalDatasetPath(), null);
});

test("reject / clear drops the Home dataset fact", async () => {
  clearAcceptedLocalFilesFromHome();
  const proposal = await proposeLocalFiles({
    files: [ref("./train.jsonl", 12)],
  });
  bindAcceptedLocalFilesToHome(acceptLocalFilesProposal(proposal));
  clearAcceptedLocalFilesFromHome();
  assert.equal(getAcceptedLocalDatasetPath(), null);
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

test("page Accept writes the home bind; composer reads it; admit stays false", async () => {
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
  assert.ok(page.includes("bindAcceptedLocalFilesToHome"));
  assert.ok(page.includes("clearAcceptedLocalFilesFromHome"));
  assert.ok(composer.includes("getAcceptedLocalDatasetPath"));
  assert.ok(composer.includes("runtimeAdmitted: false"));
  assert.ok(!/createRecipeDraft/.test(page.slice(page.indexOf("function acceptLocalFiles"))));
});
