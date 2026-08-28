// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * APP-009 — read the persisted host mlx_runtime_admission receipt.
 *
 * Home derives `runtimeAdmitted` from this receipt. Never a UI toggle,
 * never a hardcoded true. Plan still does not call Engine.
 */

import liveReceipt from "./mlx-runtime-admission.json" with { type: "json" };

export type MlxRuntimeAdmissionReceipt = {
  schema?: unknown;
  kind?: unknown;
  status?: unknown;
  authority?: unknown;
  action_taken?: unknown;
  executor_kind?: unknown;
  [key: string]: unknown;
};

export const receipt = liveReceipt as MlxRuntimeAdmissionReceipt;

/**
 * True only for an honest ADMITTED mlx_lora_adapter receipt.
 * Any missing/wrong status, authority, action_taken, executor_kind,
 * or a fake_qlora token keeps Home false.
 */
export function isRuntimeAdmitted(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const rec = value as MlxRuntimeAdmissionReceipt;
  if (rec.schema !== "studiotune.mlx-runtime-admission.v1") {
    return false;
  }
  if (rec.kind !== "mlx_runtime_admission_receipt") {
    return false;
  }
  if (rec.status !== "ADMITTED") {
    return false;
  }
  if (rec.authority !== false) {
    return false;
  }
  if (rec.action_taken !== false) {
    return false;
  }
  if (rec.executor_kind !== "mlx_lora_adapter") {
    return false;
  }
  const kind = typeof rec.kind === "string" ? rec.kind : "";
  const blob = JSON.stringify(rec);
  if (kind.includes("fake_qlora") || blob.includes("fake_qlora")) {
    return false;
  }
  return true;
}

export const runtimeAdmitted = isRuntimeAdmitted(receipt);
