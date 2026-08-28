// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

// AIN-952 / APP-010 leftover: local-files-proposal must mount on the live
// /data-recipes page. No second recipe UI, no Dexie write on Accept, no
// compare-quality claim.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const pageUrl = new URL(
  "../src/features/data-recipes/pages/data-recipes-page.tsx",
  import.meta.url,
);

async function pageSrc(): Promise<string> {
  return readFile(pageUrl, "utf8");
}

test("page imports propose/accept/reject from the existing data-layer module", async () => {
  const src = await pageSrc();
  assert.ok(
    src.includes('../data/local-files-proposal'),
    "must import local-files-proposal from the existing Dexie-layer folder",
  );
  assert.ok(src.includes("proposeLocalFiles"));
  assert.ok(src.includes("acceptLocalFilesProposal"));
  assert.ok(src.includes("rejectLocalFilesProposal"));
});

test("page keeps a single /data-recipes surface (no second recipe UI)", async () => {
  const src = await pageSrc();
  assert.ok(src.includes("Data Recipes"));
  assert.ok(src.includes("From local files"));
  assert.ok(src.includes('data-testid="data-recipes-local-files-input"'));
  assert.ok(src.includes('data-testid="data-recipes-local-files-proposal"'));
  assert.ok(src.includes('data-testid="data-recipes-local-files-accept"'));
  assert.ok(src.includes('data-testid="data-recipes-local-files-reject"'));
  assert.ok(
    !/path:\s*["']\/data-recipes-local/.test(src),
    "must not invent a second /data-recipes-* route",
  );
});

test("Accept binds Home (localStorage) — never Dexie / engine / train", async () => {
  const src = await pageSrc();
  const start = src.indexOf("function acceptLocalFiles");
  assert.ok(start >= 0, "acceptLocalFiles must exist");
  const end = src.indexOf("function rejectLocalFiles", start);
  const fn = src.slice(start, end);
  assert.ok(fn.includes("acceptLocalFilesProposal(localFilesProposal)"));
  assert.ok(fn.includes("bindAcceptedLocalFilesToHome(next)"));
  assert.ok(!fn.includes("createRecipeDraft"));
  assert.ok(!fn.includes("createRecipeFromLearningRecipe"));
  assert.ok(!/saveRecipe/.test(fn));
  assert.ok(!fn.includes("deleteRecipe"));
  assert.ok(!fn.includes("navigate("));
  assert.ok(!/\bfetch\s*\(/.test(fn));
  assert.ok(!/train/i.test(fn));
  assert.ok(!/approve/i.test(fn));
  assert.ok(!/export/i.test(fn));
});

test("Reject clears the proposal without deleting Dexie recipes", async () => {
  const src = await pageSrc();
  const start = src.indexOf("function rejectLocalFiles");
  assert.ok(start >= 0, "rejectLocalFiles must exist");
  const end = src.indexOf("const isBusy", start);
  const fn = src.slice(start, end);
  assert.ok(fn.includes("rejectLocalFilesProposal(localFilesProposal)"));
  assert.ok(fn.includes("clearAcceptedLocalFilesFromHome()"));
  assert.ok(!fn.includes("deleteRecipe"));
});
