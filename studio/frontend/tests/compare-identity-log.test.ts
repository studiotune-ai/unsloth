// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

// APP-007: frozen identity log copied from the 2230-WIB receipt.
// Texts identical. quality_claimed false. No fetch / engine / train.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  IDENTITY_LOG,
  textsIdentical,
} from "../src/features/compare/identity-log.ts";
import { evaluateCompareQuality } from "../src/features/compare/compare-quality.ts";
import { CLI007_RETAINED } from "../src/features/compare/retained-adapter-bind.ts";

const identityUrl = new URL(
  "../src/features/compare/identity-log.ts",
  import.meta.url,
);
const indexUrl = new URL(
  "../src/features/compare/index.ts",
  import.meta.url,
);

const RECEIPT_PROMPT = "Reply with the single word ping.";
const RECEIPT_TEXT =
  "\n\nI have a long story to tell you about my life.\n\nI have a";
const RECEIPT_ADAPTER_SHA =
  "4842bc09742a8bc72db1388d375fe025179697ded5deba8ddaccfc5a5b9ea8b3";
const RECEIPT_SNAPSHOT =
  "/Users/hizrianraz/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3";

test("module exports the frozen identity texts from the receipt", () => {
  assert.equal(IDENTITY_LOG.kind, "identity");
  assert.equal(IDENTITY_LOG.prompt, RECEIPT_PROMPT);
  assert.equal(IDENTITY_LOG.parent_text, RECEIPT_TEXT);
  assert.equal(IDENTITY_LOG.candidate_text, RECEIPT_TEXT);
  assert.equal(IDENTITY_LOG.adapterSha256, RECEIPT_ADAPTER_SHA);
  assert.equal(IDENTITY_LOG.parentSnapshotDir, RECEIPT_SNAPSHOT);
  assert.equal(IDENTITY_LOG.quality_claimed, false);
  assert.equal(IDENTITY_LOG.trained, false);
  assert.equal(IDENTITY_LOG.authority, false);
  assert.ok(Object.isFrozen(IDENTITY_LOG));
});

test("textsIdentical is true; quality_claimed stays false", () => {
  assert.equal(textsIdentical(), true);
  assert.equal(textsIdentical(IDENTITY_LOG), true);
  assert.equal(IDENTITY_LOG.parent_text === IDENTITY_LOG.candidate_text, true);
  assert.equal(IDENTITY_LOG.quality_claimed, false);

  const result = evaluateCompareQuality({
    parentPath: CLI007_RETAINED.parentSnapshotDir,
    candidatePath: CLI007_RETAINED.adapterDir,
    log: IDENTITY_LOG,
  });
  assert.equal(result.claimed, false);
  assert.equal(result.status, "HOLD");
  assert.equal(result.authority, false);
  assert.equal(result.reason, "identity inference is not quality");
});

test("identity-log module has no fetch / engine / train and does not import docs/", async () => {
  const src = await readFile(identityUrl, "utf8");
  assert.ok(!/\bfetch\s*\(/.test(src));
  assert.ok(!/from ["'][^"']*engine[^"']*["']/i.test(src));
  assert.ok(!/\bmlx_lm(\.lora|\.generate)?\b/.test(src));
  assert.ok(!/\btrain(edThisHop|ing)?\b/.test(src) || src.includes("trained: false"));
  assert.ok(!/\bfake_qlora\b/i.test(src));
  assert.ok(!/from ["'][^"']*docs\//.test(src));
  assert.ok(!/https?:\/\//.test(src));
});

test("features/compare barrel re-exports the frozen identity log", async () => {
  const src = await readFile(indexUrl, "utf8");
  assert.ok(src.includes("IDENTITY_LOG"));
  assert.ok(src.includes("textsIdentical"));
  assert.ok(src.includes("./identity-log"));
});
