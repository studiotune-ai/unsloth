// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/**
 * AIN-952 / APP-010 — local-files dataset proposal.
 *
 * Behaviour contract folded onto the existing `/data-recipes` surface. The
 * host page keeps its Dexie recipe store; this module adds an ephemeral,
 * in-memory proposal that mirrors the desktop-app data-recipes-view module
 * on a different repo:
 *
 *   * Local files can be proposed as a dataset recipe with a hash.
 *   * Hub / remote paths are refused (never resolved, never fetched).
 *   * Accept updates only the proposal — never approve, never run, never
 *     train, never export. It does not touch the Dexie `unsloth-data-recipes`
 *     store either.
 *   * Reject clears the proposal without touching any persisted state.
 *   * Every proposal returned carries `authority: false`. This surface has
 *     no authority to spend, sign, notarize, publish, or contact the Hub.
 *
 * The module is intentionally free of DOM, Dexie, engine, and network
 * imports so `node --test` can exercise the invariants directly.
 */

export type LocalFileRef = {
  /** Absolute or workspace-relative local filesystem path. */
  path: string;
  /** File size in bytes. */
  bytes: number;
  /**
   * Optional file digest, when the caller has one already. Included in the
   * canonical hash so callers that mint sha256 upstream get content-sensitive
   * proposal ids without this module ever reading a byte itself.
   */
  sha256?: string;
};

export type LocalFilesProposalStatus = "proposed" | "accepted";

export type LocalFilesProposal = {
  /** Stable id for this proposal. Derived from the canonical hash. */
  id: string;
  /** Canonical SHA-256 over the ordered file refs. */
  hash: string;
  /** Files backing the proposal, sorted by path for a stable hash. */
  files: readonly LocalFileRef[];
  status: LocalFilesProposalStatus;
  /**
   * A recipe-field bind label the caller may attach on Accept. Never
   * escalates to run / train / export — the caller writes this into the
   * proposal only.
   */
  recipeFieldLabel: string | null;
  /**
   * Authority is always `false`. This surface never claims permission to
   * approve, run, train, export, spend, sign, notarize, or contact the Hub.
   */
  authority: false;
  createdAt: number;
  updatedAt: number;
};

export type LocalFilesProposalError =
  | { kind: "remote-ref-refused"; path: string }
  | { kind: "empty-files" }
  | { kind: "duplicate-path"; path: string };

export class LocalFilesProposalRefused extends Error {
  readonly reason: LocalFilesProposalError;
  constructor(reason: LocalFilesProposalError) {
    super(formatReason(reason));
    this.name = "LocalFilesProposalRefused";
    this.reason = reason;
  }
}

function formatReason(reason: LocalFilesProposalError): string {
  switch (reason.kind) {
    case "remote-ref-refused":
      return `Remote or Hub path refused: ${reason.path}`;
    case "empty-files":
      return "Cannot propose an empty file set";
    case "duplicate-path":
      return `Duplicate local path: ${reason.path}`;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/**
 * Schemes and hosts that this surface must never resolve. A path is refused
 * outright if it begins with any of these, whether it addresses the Hub or
 * a generic remote object store.
 */
const REMOTE_SCHEME_PREFIXES = [
  "http://",
  "https://",
  "hf://",
  "huggingface://",
  "hub://",
  "hub:",
  "s3://",
  "gs://",
  "azure://",
  "az://",
  "gcs://",
  "r2://",
  "ftp://",
  "sftp://",
  "ssh://",
  "git://",
  "git+ssh://",
  "git+https://",
  "ipfs://",
  "ipns://",
  "ws://",
  "wss://",
  "data:",
] as const;

/**
 * Hub host markers. Any path containing one of these anywhere is refused,
 * even without an explicit scheme.
 */
const HUB_HOST_MARKERS = [
  "huggingface.co",
  "hf.co",
  "hub.huggingface.com",
] as const;

export function isRemoteRef(path: string): boolean {
  if (typeof path !== "string") {
    return true;
  }
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  for (const prefix of REMOTE_SCHEME_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return true;
    }
  }
  for (const host of HUB_HOST_MARKERS) {
    if (lower.includes(host)) {
      return true;
    }
  }
  return false;
}

function canonicalizeRef(ref: LocalFileRef): LocalFileRef {
  return {
    path: ref.path,
    bytes: ref.bytes,
    ...(ref.sha256 !== undefined ? { sha256: ref.sha256 } : {}),
  };
}

function canonicalJson(refs: readonly LocalFileRef[]): string {
  const ordered = [...refs].map(canonicalizeRef).sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  return JSON.stringify(ordered);
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "local-files-proposal: SubtleCrypto is required for hashing but is unavailable",
    );
  }
  const buf = await subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** Canonical, order-independent hash of a set of local file refs. */
export async function hashLocalFileRefs(
  refs: readonly LocalFileRef[],
): Promise<string> {
  return sha256Hex(canonicalJson(refs));
}

function assertLocalRefsOrThrow(refs: readonly LocalFileRef[]): void {
  if (refs.length === 0) {
    throw new LocalFilesProposalRefused({ kind: "empty-files" });
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    if (isRemoteRef(ref.path)) {
      throw new LocalFilesProposalRefused({
        kind: "remote-ref-refused",
        path: ref.path,
      });
    }
    if (seen.has(ref.path)) {
      throw new LocalFilesProposalRefused({
        kind: "duplicate-path",
        path: ref.path,
      });
    }
    seen.add(ref.path);
  }
}

export type ProposeLocalFilesInput = {
  files: readonly LocalFileRef[];
  now?: number;
  recipeFieldLabel?: string | null;
};

/**
 * Build a local-files proposal. Never touches the Dexie recipe store, the
 * engine, or the Hub. Throws `LocalFilesProposalRefused` if any file ref
 * addresses a remote / Hub location.
 */
export async function proposeLocalFiles(
  input: ProposeLocalFilesInput,
): Promise<LocalFilesProposal> {
  assertLocalRefsOrThrow(input.files);
  const files = [...input.files].map(canonicalizeRef).sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  const hash = await hashLocalFileRefs(files);
  const now = input.now ?? Date.now();
  return {
    id: `local-files:${hash}`,
    hash,
    files,
    status: "proposed",
    recipeFieldLabel: input.recipeFieldLabel ?? null,
    authority: false,
    createdAt: now,
    updatedAt: now,
  };
}

export type AcceptLocalFilesInput = {
  /** Optional label to bind onto the proposal recipe field. */
  recipeFieldLabel?: string | null;
  now?: number;
};

/**
 * Accept the proposal. This ONLY updates the in-memory proposal record.
 * It never approves, runs, trains, exports, or contacts the Hub. The Dexie
 * `unsloth-data-recipes` store is not touched.
 *
 * Returns a new proposal object; the input is not mutated.
 */
export function acceptLocalFilesProposal(
  proposal: LocalFilesProposal,
  patch: AcceptLocalFilesInput = {},
): LocalFilesProposal {
  return {
    ...proposal,
    status: "accepted",
    recipeFieldLabel:
      patch.recipeFieldLabel !== undefined
        ? patch.recipeFieldLabel
        : proposal.recipeFieldLabel,
    authority: false,
    updatedAt: patch.now ?? Date.now(),
  };
}

/**
 * Reject the proposal. Returns `null`; no persisted state is touched, no
 * engine call, no Hub call, no Dexie write. The caller drops the proposal
 * from its state.
 */
export function rejectLocalFilesProposal(
  _proposal: LocalFilesProposal | null,
): null {
  return null;
}
