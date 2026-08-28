// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * APP-009 — Home runtimeAdmitted is derived from the admission receipt.
 * Never hardcoded true. Never a UI toggle. Fake / authority receipts stay false.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isRuntimeAdmitted,
  receipt,
} from "../src/features/home/mlx-runtime-admission.ts";

const HONEST: Record<string, unknown> = {
  schema: "studiotune.mlx-runtime-admission.v1",
  kind: "mlx_runtime_admission_receipt",
  status: "ADMITTED",
  authority: false,
  action_taken: false,
  executor_kind: "mlx_lora_adapter",
};

test("ADMITTED + honest fields => true", () => {
  assert.equal(isRuntimeAdmitted(HONEST), true);
});

test("missing or wrong status => false", () => {
  assert.equal(isRuntimeAdmitted({ ...HONEST, status: "NOT_ADMITTED" }), false);
  assert.equal(isRuntimeAdmitted({ ...HONEST, status: "FAIL" }), false);
  const missing = { ...HONEST };
  delete missing.status;
  assert.equal(isRuntimeAdmitted(missing), false);
  assert.equal(isRuntimeAdmitted(null), false);
  assert.equal(isRuntimeAdmitted(undefined), false);
});

test("authority true => false", () => {
  assert.equal(isRuntimeAdmitted({ ...HONEST, authority: true }), false);
});

test("fake_qlora in kind => false", () => {
  assert.equal(
    isRuntimeAdmitted({ ...HONEST, kind: "fake_qlora_receipt" }),
    false,
  );
  assert.equal(
    isRuntimeAdmitted({ ...HONEST, note: "fake_qlora probe" }),
    false,
  );
});

test("action_taken true => false", () => {
  assert.equal(isRuntimeAdmitted({ ...HONEST, action_taken: true }), false);
});

test("live persisted receipt is honest ADMITTED and derived true", () => {
  const live = JSON.parse(
    readFileSync(
      new URL(
        "../src/features/home/mlx-runtime-admission.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(live.schema, "studiotune.mlx-runtime-admission.v1");
  assert.equal(live.kind, "mlx_runtime_admission_receipt");
  assert.equal(live.status, "ADMITTED");
  assert.equal(live.authority, false);
  assert.equal(live.action_taken, false);
  assert.equal(live.executor_kind, "mlx_lora_adapter");
  assert.equal(live.trained, undefined);
  assert.ok(!JSON.stringify(live).includes("fake_qlora"));
  assert.equal(isRuntimeAdmitted(live), true);
  assert.equal(isRuntimeAdmitted(receipt), true);
});

test("composer derives runtimeAdmitted from the receipt helper, not a toggle", () => {
  const composer = readFileSync(
    new URL("../src/features/home/home-composer.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(composer.includes("isRuntimeAdmitted(receipt)"));
  assert.ok(!composer.includes("runtimeAdmitted: true"));
  assert.ok(!composer.includes("runtimeAdmitted: false"));
  assert.ok(composer.includes("disabled"));
  assert.ok(!/runtimeAdmitted:\s*e\.target\.checked/.test(composer));
});
