// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * Compare quality freeze (APP-007 / AIN-938 leftover of AIN-952).
 *
 * Quality stays HOLD. This hop never scores. Fixtures are not quality.
 * Hub / remote paths are refused. Even a real local parent+candidate
 * identity log (parent vs parent+adapter, boring ping prompt) returns
 * claimed=false — identity inference is not a quality score.
 */

export type CompareQualityStatus = "HOLD";

export type CompareQualityResult = {
  claimed: false;
  status: CompareQualityStatus;
  reason: string;
  authority: false;
};

export type CompareLog = {
  fixture?: boolean;
  kind?: string;
  source?: string;
  label?: string;
  labeled?: string;
  type?: string;
  quality_claimed?: boolean;
  trained?: boolean;
  parent_text?: string;
  candidate_text?: string;
  prompt?: string;
};

export type EvaluateCompareQualityInput = {
  parentPath?: string | null;
  candidatePath?: string | null;
  log?: CompareLog | string | null;
};

export class CompareQualityRefused extends Error {
  readonly code = "COMPARE_QUALITY_REMOTE_REFUSED" as const;

  constructor(message: string) {
    super(message);
    this.name = "CompareQualityRefused";
  }
}

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

const HUB_HOST_MARKERS = [
  "huggingface.co",
  "hf.co",
  "hub.huggingface.com",
] as const;

/** Bare Hub id: org/name with no local path prefix. */
const BARE_HUB_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

export function isRemoteComparePath(path: string): boolean {
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
  if (BARE_HUB_ID.test(trimmed)) {
    return true;
  }
  return false;
}

function providedPath(path?: string | null): string | null {
  if (typeof path !== "string") {
    return null;
  }
  const trimmed = path.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function isFixtureLog(log: CompareLog | string | null | undefined): boolean {
  if (log == null) {
    return false;
  }
  if (typeof log === "string") {
    return /\bfixture\b/i.test(log);
  }
  if (log.fixture === true) {
    return true;
  }
  const fields = [log.kind, log.source, log.label, log.labeled, log.type];
  return fields.some(
    (value) => typeof value === "string" && /\bfixture\b/i.test(value),
  );
}

/** Identity parent+candidate text is a bind/generate log, not a score. */
function isIdentityLog(log: CompareLog | string | null | undefined): boolean {
  if (log == null || typeof log === "string") {
    return false;
  }
  if (typeof log.kind === "string" && /\bidentity\b/i.test(log.kind)) {
    return true;
  }
  const hasPair =
    typeof log.parent_text === "string" && typeof log.candidate_text === "string";
  if (hasPair && log.quality_claimed === false) {
    return true;
  }
  if (hasPair && log.trained === false) {
    return true;
  }
  return false;
}

/**
 * Freeze HOLD. Never invent a score. Never treat fixtures as quality.
 * A real local parent + candidate + identity log still returns
 * claimed=false — identity inference is not quality.
 */
export function evaluateCompareQuality(
  input: EvaluateCompareQualityInput,
): CompareQualityResult {
  const parentPath = providedPath(input.parentPath);
  const candidatePath = providedPath(input.candidatePath);

  if (parentPath && isRemoteComparePath(parentPath)) {
    throw new CompareQualityRefused(
      `parentPath is remote / Hub and is refused: ${parentPath}`,
    );
  }
  if (candidatePath && isRemoteComparePath(candidatePath)) {
    throw new CompareQualityRefused(
      `candidatePath is remote / Hub and is refused: ${candidatePath}`,
    );
  }

  if (!parentPath || !candidatePath) {
    return {
      claimed: false,
      status: "HOLD",
      reason: "missing parent or candidate",
      authority: false,
    };
  }

  if (input.log == null || (typeof input.log === "string" && input.log.trim() === "")) {
    return {
      claimed: false,
      status: "HOLD",
      reason: "missing compare log",
      authority: false,
    };
  }

  if (isFixtureLog(input.log)) {
    return {
      claimed: false,
      status: "HOLD",
      reason: "fixture log cannot claim quality",
      authority: false,
    };
  }

  if (isIdentityLog(input.log)) {
    return {
      claimed: false,
      status: "HOLD",
      reason: "identity inference is not quality",
      authority: false,
    };
  }

  return {
    claimed: false,
    status: "HOLD",
    reason: "no live parent/candidate inference yet",
    authority: false,
  };
}
