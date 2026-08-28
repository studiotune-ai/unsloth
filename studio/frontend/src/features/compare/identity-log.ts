// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * Frozen APP-007 identity inference log (copied from the 2230-WIB receipt).
 *
 * Do not fetch. Do not import from docs/ at runtime. This is a bind/generate
 * identity pair, not a quality score. No engine, no train, no Hub.
 */

export type IdentityLog = {
  kind: "identity";
  prompt: string;
  parent_text: string;
  candidate_text: string;
  adapterSha256: string;
  parentSnapshotDir: string;
  quality_claimed: false;
  trained: false;
  authority: false;
};

/** Live identity pair from APP-007-IDENTITY-INFERENCE-2026-08-28-2230-WIB. */
export const IDENTITY_LOG: IdentityLog = Object.freeze({
  kind: "identity",
  prompt: "Reply with the single word ping.",
  parent_text:
    "\n\nI have a long story to tell you about my life.\n\nI have a",
  candidate_text:
    "\n\nI have a long story to tell you about my life.\n\nI have a",
  adapterSha256:
    "4842bc09742a8bc72db1388d375fe025179697ded5deba8ddaccfc5a5b9ea8b3",
  parentSnapshotDir:
    "/Users/hizrianraz/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
  quality_claimed: false,
  trained: false,
  authority: false,
});

export function textsIdentical(
  log: Pick<IdentityLog, "parent_text" | "candidate_text"> = IDENTITY_LOG,
): boolean {
  return log.parent_text === log.candidate_text;
}
