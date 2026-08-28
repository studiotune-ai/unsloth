// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * APP-007 / AIN-938 — bind the already-on-disk CLI-007 retained adapter.
 *
 * Inspect / bind only. No Engine call, no training, no Hub contact.
 * Quality stays unclaimed.
 */

import { isRemoteComparePath } from "./compare-quality.ts";

export class RetainedAdapterBindRefused extends Error {
  readonly code = "RETAINED_ADAPTER_REMOTE_REFUSED" as const;

  constructor(message: string) {
    super(message);
    this.name = "RetainedAdapterBindRefused";
  }
}

export type BindRetainedAdapterInput = {
  adapterDir: string;
  parentSnapshotDir: string;
  adapterSha256: string;
};

export type RetainedAdapterBind = {
  kind: "retained_adapter";
  adapterSha256: string;
  parentSnapshot: string;
  adapterDir: string;
  authority: false;
  qualityClaimed: false;
  trainedThisHop: false;
};

/** Live-inspected CLI-007 adapter (sha256 verified 2026-08-28, not retrained). */
export const CLI007_RETAINED = {
  adapterDir: "/tmp/studiotune-cli-007/adapter",
  parentSnapshotDir:
    "/Users/hizrianraz/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
  adapterSha256:
    "4842bc09742a8bc72db1388d375fe025179697ded5deba8ddaccfc5a5b9ea8b3",
  adapterConfigSha256:
    "15fe42f29a937c35084632b1e1c46790162065a53753a542f417cb94afcddfc1",
} as const;

const SHA256_HEX = /^[a-f0-9]{64}$/;

function providedPath(path: string, label: string): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new RetainedAdapterBindRefused(`${label} is required`);
  }
  const trimmed = path.trim();
  if (isRemoteComparePath(trimmed)) {
    throw new RetainedAdapterBindRefused(
      `${label} is remote / Hub and is refused: ${trimmed}`,
    );
  }
  return trimmed;
}

/**
 * Record a bind to a retained local adapter. Pure — no Engine, no train,
 * no export, no filesystem side effects.
 */
export function bindRetainedAdapter(
  input: BindRetainedAdapterInput,
): RetainedAdapterBind {
  const adapterDir = providedPath(input.adapterDir, "adapterDir");
  const parentSnapshot = providedPath(
    input.parentSnapshotDir,
    "parentSnapshotDir",
  );
  const adapterSha256 =
    typeof input.adapterSha256 === "string"
      ? input.adapterSha256.trim().toLowerCase()
      : "";
  if (!SHA256_HEX.test(adapterSha256)) {
    throw new RetainedAdapterBindRefused(
      "adapterSha256 must be a 64-char lowercase hex digest from a live inspect",
    );
  }

  return {
    kind: "retained_adapter",
    adapterSha256,
    parentSnapshot,
    adapterDir,
    authority: false,
    qualityClaimed: false,
    trainedThisHop: false,
  };
}
