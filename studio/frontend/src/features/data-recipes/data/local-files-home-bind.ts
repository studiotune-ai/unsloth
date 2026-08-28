// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/**
 * APP-010 leftover: an accepted local-files proposal may seed the Home
 * composer dataset fact. Memory plus `localStorage` under
 * `studiotune.home.dataset-bind.v1` so the bind survives relaunch.
 * Never Dexie `unsloth-data-recipes` (no RecipeRecord), never Engine,
 * never train, never a Hub id or remote ref. Reject / clear wipes both
 * memory and the store. runtimeAdmitted is not flipped here — Home
 * still derives it from `isRuntimeAdmitted(receipt)`.
 */

import { isRemoteRef } from "./local-files-proposal.ts";
import type { LocalFilesProposal } from "./local-files-proposal.ts";
import { looksLikeHubId } from "../../home/outcome-plan-builder.ts";

export const HOME_DATASET_BIND_STORAGE_KEY = "studiotune.home.dataset-bind.v1";

export type AcceptedLocalDatasetBind = {
  path: string;
  hash: string;
  authority: false;
};

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getLocalStorage(): Storage | null {
  try {
    const ls = globalThis.localStorage;
    if (!ls || typeof ls.getItem !== "function") {
      return null;
    }
    return ls;
  } catch {
    return null;
  }
}

function isPersistableBind(bind: {
  path: unknown;
  hash: unknown;
  authority: unknown;
}): bind is AcceptedLocalDatasetBind {
  if (typeof bind.path !== "string" || bind.path.trim().length === 0) {
    return false;
  }
  if (typeof bind.hash !== "string" || bind.hash.length === 0) {
    return false;
  }
  if (bind.authority !== false) {
    return false;
  }
  if (isRemoteRef(bind.path) || looksLikeHubId(bind.path)) {
    return false;
  }
  return true;
}

function persist(bind: AcceptedLocalDatasetBind | null): void {
  const ls = getLocalStorage();
  if (!ls) {
    return;
  }
  try {
    if (bind === null || !isPersistableBind(bind)) {
      ls.removeItem(HOME_DATASET_BIND_STORAGE_KEY);
      return;
    }
    ls.setItem(
      HOME_DATASET_BIND_STORAGE_KEY,
      JSON.stringify({
        path: bind.path,
        hash: bind.hash,
        authority: false,
      }),
    );
  } catch {
    // Private-mode / quota: keep the in-session bind, drop persist.
  }
}

function hydrateFromStore(): AcceptedLocalDatasetBind | null {
  const ls = getLocalStorage();
  if (!ls) {
    return null;
  }
  let raw: string | null;
  try {
    raw = ls.getItem(HOME_DATASET_BIND_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      ls.removeItem(HOME_DATASET_BIND_STORAGE_KEY);
      return null;
    }
    const rec = parsed as { path?: unknown; hash?: unknown; authority?: unknown };
    const path = rec.path;
    const hash = rec.hash;
    if (
      typeof path !== "string" ||
      path.trim().length === 0 ||
      typeof hash !== "string" ||
      hash.length === 0 ||
      rec.authority !== false ||
      isRemoteRef(path) ||
      looksLikeHubId(path)
    ) {
      ls.removeItem(HOME_DATASET_BIND_STORAGE_KEY);
      return null;
    }
    return { path, hash, authority: false };
  } catch {
    try {
      ls.removeItem(HOME_DATASET_BIND_STORAGE_KEY);
    } catch {
      // ignore
    }
    return null;
  }
}

let accepted: AcceptedLocalDatasetBind | null = hydrateFromStore();

/**
 * Re-read `studiotune.home.dataset-bind.v1` into memory. Remote / invalid /
 * authority!==false fail-close to null and clear the store. Called on
 * module load; tests call it again to simulate relaunch.
 */
export function hydrateAcceptedLocalDatasetBind(): AcceptedLocalDatasetBind | null {
  accepted = hydrateFromStore();
  notify();
  return accepted;
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
    persist(null);
    notify();
    return null;
  }
  const path = proposal.files[0].path;
  const next: AcceptedLocalDatasetBind = {
    path,
    hash: proposal.hash,
    authority: false,
  };
  if (!isPersistableBind(next)) {
    accepted = null;
    persist(null);
    notify();
    return null;
  }
  accepted = next;
  persist(accepted);
  notify();
  return accepted;
}

export function clearAcceptedLocalFilesFromHome(): void {
  accepted = null;
  persist(null);
  notify();
}
