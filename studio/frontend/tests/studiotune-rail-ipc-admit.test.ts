// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * APP-009 leftover — rail IPC / plan-session initial runtimeAdmitted
 * is derived from the Home mlx receipt helper. Never hardcoded true.
 * Never a fake IPC admit. Live refuse still fail-closes.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isRuntimeAdmitted,
  receipt,
} from "../src/features/home/mlx-runtime-admission.ts";
import { EMPTY_PLAN_SESSION } from "../src/features/home/plan-session-store.ts";
import {
  makeDisconnectedTuneAgentBridge,
  makeLiveTuneAgentBridge,
} from "../src/features/tune-agent/tune-agent-ipc.ts";

const HONEST: Record<string, unknown> = {
  schema: "studiotune.mlx-runtime-admission.v1",
  kind: "mlx_runtime_admission_receipt",
  status: "ADMITTED",
  authority: false,
  action_taken: false,
  executor_kind: "mlx_lora_adapter",
};

const IPC_SOURCE = readFileSync(
  new URL("../src/features/tune-agent/tune-agent-ipc.ts", import.meta.url),
  "utf8",
);
const STORE_SOURCE = readFileSync(
  new URL("../src/features/home/plan-session-store.ts", import.meta.url),
  "utf8",
);

test("disconnected initial runtimeAdmitted equals isRuntimeAdmitted(receipt)", () => {
  const bridge = makeDisconnectedTuneAgentBridge("no-tauri");
  assert.equal(bridge.getState().runtimeAdmitted, isRuntimeAdmitted(receipt));
  assert.equal(bridge.getState().runtimeAdmitted, true);
});

test("live initial runtimeAdmitted equals helper even when handshake admit is null", () => {
  const bridge = makeLiveTuneAgentBridge(async () => undefined as never, {
    connected: true,
    binary: "/path",
    admit: null,
    lastError: null,
  });
  assert.equal(bridge.getState().runtimeAdmitted, isRuntimeAdmitted(receipt));
  assert.equal(bridge.getState().runtimeAdmitted, true);
});

test("live handshake admitted=true is fine only because the receipt is ADMITTED", () => {
  const bridge = makeLiveTuneAgentBridge(async () => undefined as never, {
    connected: true,
    binary: "/path",
    admit: {
      admitted: true,
      python: "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13",
      snapshot: "~/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
      reason: null,
      hfHubOffline: "1",
    },
    lastError: null,
  });
  assert.equal(isRuntimeAdmitted(receipt), true);
  assert.equal(bridge.getState().runtimeAdmitted, true);
});

test("helper stays false for missing/wrong status, authority, or fake_qlora", () => {
  assert.equal(isRuntimeAdmitted({ ...HONEST, status: "NOT_ADMITTED" }), false);
  assert.equal(isRuntimeAdmitted({ ...HONEST, status: "FAIL" }), false);
  const missing = { ...HONEST };
  delete missing.status;
  assert.equal(isRuntimeAdmitted(missing), false);
  assert.equal(isRuntimeAdmitted({ ...HONEST, authority: true }), false);
  assert.equal(
    isRuntimeAdmitted({ ...HONEST, kind: "fake_qlora_receipt" }),
    false,
  );
  assert.equal(
    isRuntimeAdmitted({ ...HONEST, note: "fake_qlora probe" }),
    false,
  );
  assert.equal(isRuntimeAdmitted({ ...HONEST, action_taken: true }), false);
  assert.equal(isRuntimeAdmitted(null), false);
});

test("handshake admitted cannot override a non-ADMITTED receipt (receipt wins)", () => {
  // Receipt is the authority for the Home-derived bit. A sidecar
  // handshake that claims admitted is not enough on its own.
  assert.equal(isRuntimeAdmitted({ ...HONEST, status: "FAIL" }), false);
  assert.equal(isRuntimeAdmitted({ ...HONEST, authority: true }), false);
  assert.ok(IPC_SOURCE.includes("isRuntimeAdmitted(receipt)"));
  assert.ok(
    !IPC_SOURCE.includes("runtimeAdmitted: initial.admit?.admitted === true"),
    "live initial must not trust handshake admit without the receipt helper",
  );
});

test("live refuse still fail-closes runtimeAdmitted to false", async () => {
  const invoke = async (cmd: string) => {
    if (cmd === "tune_agent_admit_runtime") {
      throw new Error("admit refused: host python is not a regular file");
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  };
  const bridge = makeLiveTuneAgentBridge(invoke as never, {
    connected: true,
    binary: "/path",
    admit: null,
    lastError: null,
  });
  assert.equal(bridge.getState().runtimeAdmitted, true);
  const got = await bridge.admitRuntime!({
    python: "/usr/bin/python3",
    snapshot:
      "~/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
    mlxArgs: [],
  });
  assert.equal(got?.admitted, false);
  assert.equal(bridge.getState().runtimeAdmitted, false);
});

test("plan-session default uses the same helper so a new session does not re-inject missing-admit", () => {
  assert.equal(
    EMPTY_PLAN_SESSION.facts.runtimeAdmitted,
    isRuntimeAdmitted(receipt),
  );
  assert.equal(EMPTY_PLAN_SESSION.facts.runtimeAdmitted, true);
  assert.ok(STORE_SOURCE.includes("isRuntimeAdmitted(receipt)"));
  assert.ok(!/runtimeAdmitted:\s*false/.test(STORE_SOURCE));
  assert.ok(!/runtimeAdmitted:\s*true/.test(STORE_SOURCE));
});

test("IPC source derives initial state from the helper and keeps refuse fail-close", () => {
  assert.ok(IPC_SOURCE.includes("isRuntimeAdmitted(receipt)"));
  assert.ok(!/runtimeAdmitted:\s*true/.test(IPC_SOURCE));
  assert.match(
    IPC_SOURCE,
    /runtimeAdmitted:\s*false/,
    "live refuse / error must still assign runtimeAdmitted: false",
  );
  // No invented IPC admit on load — start still only talks to tune_agent_start.
  const load = IPC_SOURCE.slice(IPC_SOURCE.indexOf("export async function loadTuneAgentBridge"));
  assert.ok(load.includes("tune_agent_start"));
  assert.ok(!load.includes("tune_agent_admit_runtime"));
});
