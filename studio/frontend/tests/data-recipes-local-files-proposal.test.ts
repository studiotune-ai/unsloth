// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

// AIN-952 / APP-010 — the desktop-app data-recipes-view module on a different
// repo ships eight invariants for local-files proposals. This suite mirrors
// those invariants on the Unsloth host surface. The module under test lives
// in the same Dexie-layer folder as `recipes-db.ts`; we deliberately do NOT
// touch that store here, since Accept must not create a Recipe row and
// Reject must not touch persisted state.

import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalFilesProposalRefused,
  acceptLocalFilesProposal,
  hashLocalFileRefs,
  isRemoteRef,
  proposeLocalFiles,
  rejectLocalFilesProposal,
} from "../src/features/data-recipes/data/local-files-proposal.ts";
import type {
  LocalFileRef,
  LocalFilesProposal,
} from "../src/features/data-recipes/data/local-files-proposal.ts";

function ref(path: string, bytes: number, sha256?: string): LocalFileRef {
  return sha256 !== undefined ? { path, bytes, sha256 } : { path, bytes };
}

test("propose: local files become a hashed dataset proposal", async () => {
  // Invariant 1: local file refs on disk are proposed as a dataset recipe
  // whose id is derived from a canonical hash. The hash must be stable
  // across independent calls with the same inputs, and independent of the
  // caller's insertion order.
  const files: LocalFileRef[] = [
    ref("./datasets/train/a.jsonl", 1024, "aa"),
    ref("./datasets/train/b.jsonl", 2048, "bb"),
    ref("./datasets/eval/c.jsonl", 512, "cc"),
  ];
  const a = await proposeLocalFiles({ files, now: 1_000 });
  const b = await proposeLocalFiles({
    files: [files[2], files[0], files[1]],
    now: 2_000,
  });
  const expectedHash = await hashLocalFileRefs(files);
  assert.equal(a.hash, expectedHash);
  assert.equal(a.hash, b.hash);
  assert.equal(a.id, `local-files:${expectedHash}`);
  assert.equal(a.status, "proposed");
  assert.equal(a.recipeFieldLabel, null);
  assert.equal(a.authority, false);
  assert.equal(a.files.length, 3);
  const paths = a.files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort());
});

test("propose: refuses Hub, remote, and bare-hub-id paths outright", async () => {
  // Invariant 2: the surface must not resolve or fetch any remote / Hub
  // reference. Even bare `owner/dataset` ids that would be interpreted as
  // a Hub dataset by any downstream must throw.
  const refused = [
    "https://huggingface.co/datasets/foo/bar",
    "http://example.com/x.jsonl",
    "hf://datasets/foo/bar",
    "huggingface://foo/bar",
    "hub://foo/bar",
    "s3://bucket/key",
    "gs://bucket/key",
    "ftp://host/file",
    "data:text/plain,hi",
    "  https://huggingface.co/x  ",
    "https://hf.co/owner/dataset",
    "",
    "   ",
  ];
  for (const path of refused) {
    await assert.rejects(
      proposeLocalFiles({ files: [ref(path, 1)] }),
      LocalFilesProposalRefused,
      `expected refusal for ${JSON.stringify(path)}`,
    );
    assert.equal(
      isRemoteRef(path),
      true,
      `isRemoteRef(${JSON.stringify(path)})`,
    );
  }
  const allowed = [
    "./datasets/a.jsonl",
    "../datasets/a.jsonl",
    "/abs/path/a.jsonl",
    "~/datasets/a.jsonl",
    "C:\\Users\\x\\a.jsonl",
    "D:/Users/x/a.jsonl",
    "\\\\server\\share\\a.jsonl",
    "datasets/a.jsonl",
    "a.jsonl",
  ];
  for (const path of allowed) {
    assert.equal(
      isRemoteRef(path),
      false,
      `isRemoteRef(${JSON.stringify(path)}) must be false`,
    );
    const proposal = await proposeLocalFiles({ files: [ref(path, 1)] });
    assert.equal(proposal.files[0].path, path);
    assert.equal(proposal.authority, false);
  }
});

test("propose: refuses empty file sets and duplicate paths", async () => {
  // A propose call with no files or with duplicated paths is a malformed
  // proposal, not a running dataset; the surface must refuse before it
  // hashes.
  await assert.rejects(
    proposeLocalFiles({ files: [] }),
    LocalFilesProposalRefused,
  );
  await assert.rejects(
    proposeLocalFiles({
      files: [ref("./a.jsonl", 1), ref("./a.jsonl", 1)],
    }),
    LocalFilesProposalRefused,
  );
});

test("propose: hash is content-sensitive on path, bytes, and sha256", async () => {
  // Invariant 3: two proposals with identical file sets share a hash;
  // changing any of {path, bytes, sha256} must change the hash.
  const base: LocalFileRef[] = [
    ref("./a.jsonl", 1024, "aa"),
    ref("./b.jsonl", 2048, "bb"),
  ];
  const p = await proposeLocalFiles({ files: base });
  const same = await proposeLocalFiles({ files: base });
  assert.equal(p.hash, same.hash);

  const renamed = await proposeLocalFiles({
    files: [ref("./a.jsonl", 1024, "aa"), ref("./c.jsonl", 2048, "bb")],
  });
  assert.notEqual(p.hash, renamed.hash);

  const resized = await proposeLocalFiles({
    files: [ref("./a.jsonl", 4096, "aa"), ref("./b.jsonl", 2048, "bb")],
  });
  assert.notEqual(p.hash, resized.hash);

  const rehashed = await proposeLocalFiles({
    files: [ref("./a.jsonl", 1024, "zz"), ref("./b.jsonl", 2048, "bb")],
  });
  assert.notEqual(p.hash, rehashed.hash);
});

test("accept: updates only the proposal — never train / run / export / persist", async () => {
  // Invariant 4: Accept is a recipe-field bind on the proposal itself.
  // It must not mutate the input, must keep the hash stable, must NOT
  // touch the Dexie `unsloth-data-recipes` store, and must never call
  // through to any engine, hub, or filesystem side-effect. We assert the
  // returned shape and that the module has no such imports.
  const original = await proposeLocalFiles({
    files: [ref("./a.jsonl", 1024, "aa")],
    now: 1_000,
  });
  const accepted = acceptLocalFilesProposal(original, {
    recipeFieldLabel: "train.jsonl",
    now: 2_000,
  });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.hash, original.hash);
  assert.equal(accepted.id, original.id);
  assert.equal(accepted.recipeFieldLabel, "train.jsonl");
  assert.equal(accepted.authority, false);
  assert.equal(accepted.createdAt, 1_000);
  assert.equal(accepted.updatedAt, 2_000);

  // Non-mutation: the input proposal is untouched.
  assert.equal(original.status, "proposed");
  assert.equal(original.recipeFieldLabel, null);
  assert.equal(original.updatedAt, 1_000);

  // No side-effect imports. The module must be free of Dexie, engine,
  // network, and hub reachability at the source level.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(
    new URL(
      "../src/features/data-recipes/data/local-files-proposal.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(!/from ["']dexie["']/.test(src), "must not import dexie");
  assert.ok(
    !/from ["'][^"']*engine[^"']*["']/i.test(src),
    "must not import any engine module",
  );
  assert.ok(
    !/from ["'][^"']*hub[^"']*["']/i.test(src),
    "must not import any hub module",
  );
  assert.ok(!/\bfetch\s*\(/.test(src), "must not call fetch()");
  assert.ok(!/XMLHttpRequest/.test(src), "must not touch XHR");
  assert.ok(!/recipes-db/.test(src), "must not touch the recipes Dexie store");
});

test("reject: clears the proposal without touching persisted state", () => {
  // Invariant 5: Reject returns null and does not mutate the input.
  // There is no persisted state to unwind because Accept never wrote
  // one — the proposal is in-memory only.
  const proposal: LocalFilesProposal = {
    id: "local-files:zzz",
    hash: "zzz",
    files: [{ path: "./a.jsonl", bytes: 1 }],
    status: "proposed",
    recipeFieldLabel: null,
    authority: false,
    createdAt: 0,
    updatedAt: 0,
  };
  const before = JSON.stringify(proposal);
  assert.equal(rejectLocalFilesProposal(proposal), null);
  assert.equal(JSON.stringify(proposal), before);
  assert.equal(rejectLocalFilesProposal(null), null);
  const accepted = acceptLocalFilesProposal(proposal);
  assert.equal(rejectLocalFilesProposal(accepted), null);
});

test("authority=false on every proposal, at every status", async () => {
  // Invariant 6: this surface has no authority to spend, sign, notarize,
  // publish, run, train, export, or contact the Hub. Every proposal it
  // returns advertises that, and Accept cannot flip it.
  const p = await proposeLocalFiles({ files: [ref("./a.jsonl", 1)] });
  assert.equal(p.authority, false);
  const a = acceptLocalFilesProposal(p);
  assert.equal(a.authority, false);
  const a2 = acceptLocalFilesProposal(p, { recipeFieldLabel: "x" });
  assert.equal(a2.authority, false);
});

test("propose surface stays on the /data-recipes route (no second recipe UI)", async () => {
  // Invariant 7: AIN-952 forbids inventing a second recipe UI or a second
  // `/data-recipes` route. Enforced at the source level: the module lives
  // in the existing data-recipes/data/ folder and the barrel re-exports
  // it. No new page or route file may appear.
  const { readFile } = await import("node:fs/promises");
  const barrel = await readFile(
    new URL("../src/features/data-recipes/index.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    barrel.includes("./data/local-files-proposal"),
    "data-recipes barrel must re-export local-files-proposal from the Dexie-layer folder",
  );
  assert.ok(
    barrel.includes("proposeLocalFiles") &&
      barrel.includes("acceptLocalFilesProposal") &&
      barrel.includes("rejectLocalFilesProposal"),
    "the barrel must expose propose/accept/reject",
  );
  const routerSrc = await readFile(
    new URL(
      "../src/features/data-recipes/pages/data-recipes-page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(
    routerSrc.includes("Data Recipes"),
    "existing /data-recipes page title must remain",
  );
});

test("hash is stable across permutations and canonicalizes the file list", async () => {
  // Invariant 8: order-independent hashing means the accepted proposal id
  // is deterministic no matter which order the file picker delivered its
  // refs in. This is what lets the caller diff two picks without
  // committing either.
  const a = [
    ref("./z.jsonl", 3, "zz"),
    ref("./a.jsonl", 1, "aa"),
    ref("./m.jsonl", 2, "mm"),
  ];
  const b = [a[2], a[0], a[1]];
  const c = [a[1], a[2], a[0]];
  const h1 = await hashLocalFileRefs(a);
  const h2 = await hashLocalFileRefs(b);
  const h3 = await hashLocalFileRefs(c);
  assert.equal(h1, h2);
  assert.equal(h2, h3);

  const p = await proposeLocalFiles({ files: b });
  assert.equal(
    p.files.map((f) => f.path).join(","),
    "./a.jsonl,./m.jsonl,./z.jsonl",
  );
});
