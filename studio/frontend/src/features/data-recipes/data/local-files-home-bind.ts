// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/**
 * APP-009 leftover: an accepted APP-010 local-files proposal may seed the
 * Home composer dataset fact. In-memory only. Never Dexie, never Engine,
 * never train. Reject clears the bind. runtimeAdmitted is not flipped here.
 */

import { isRemoteRef } from "./local-files-proposal.ts";
import type { LocalFilesProposal } from "./local-files-proposal.ts";

export type AcceptedLocalDatasetBind = {
  path: string;
  hash: string;
  authority: false;
};

let accepted: AcceptedLocalDatasetBind | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getAcceptedLocalDatasetPath(): string | null {
  return accepted?.path ?? null;
}

export function getAcceptedLocalDatasetBind(): AcceptedLocalDatasetBind | null {
  return accepted;
}

export function subscribeAcceptedLocalDataset(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function bindAcceptedLocalFilesToHome(
  proposal: LocalFilesProposal,
): AcceptedLocalDatasetBind | null {
  if (proposal.status !== "accepted" || proposal.files.length === 0) {
    accepted = null;
    notify();
    return null;
  }
  const path = proposal.files[0].path;
  if (isRemoteRef(path)) {
    accepted = null;
    notify();
    return null;
  }
  accepted = { path, hash: proposal.hash, authority: false };
  notify();
  return accepted;
}

export function clearAcceptedLocalFilesFromHome(): void {
  accepted = null;
  notify();
}
