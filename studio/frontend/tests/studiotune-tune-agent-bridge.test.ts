// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * Live Tune Agent bridge tests.
 *
 * These sit on top of the existing guard tests and prove:
 *   1. When Tauri is present but the sidecar refuses to start, the
 *      loader falls back to the disconnected bridge (never a live one).
 *   2. The live bridge's requestPlan returns null and drops back to
 *      disconnected as soon as the underlying invoke rejects.
 *   3. admitRuntime forwards the exact python / snapshot / mlxArgs the
 *      rail sends and reports an honest not-admitted outcome when the
 *      host refuses (rather than pretending admission succeeded).
 *   4. Accept still never calls Engine, Plan still cannot Train, Agent
 *      still refuses without admit — with the live bridge in play.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPlanRecipe,
  canStartTrainFromMode,
  requireAdmittedRuntime,
} from "../src/features/tune-agent/tune-agent-guards.ts";
import {
  DEFAULT_TUNE_AGENT_BINARY_PATH,
  loadTuneAgentBridge,
  makeDisconnectedTuneAgentBridge,
  makeLiveTuneAgentBridge,
} from "../src/features/tune-agent/tune-agent-ipc.ts";
import type {
  OutcomePlan,
  TuneAgentAdmitOutcome,
} from "../src/features/tune-agent/tune-agent-types.ts";

// Neutral cleanup helper: every test that pokes globalThis must restore it,
// or the next test in the file runs against a poisoned bridge.
function withStubbedWindow<T>(
  stub: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = stub;
  return fn().finally(() => {
    if (original === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = original;
    }
  });
}

test("loader hands back a disconnected bridge under Node (no window at all)", async () => {
  const bridge = await loadTuneAgentBridge();
  const state = bridge.getState();
  assert.equal(state.connected, false);
  assert.equal(state.plan, null);
});

test("loader downgrades to disconnected when the sidecar cannot start", async () => {
  const invocations: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    invocations.push({ cmd, args });
    if (cmd === "tune_agent_start") {
      // Rust returns a status object even on failure; the bridge must read
      // `connected: false` and fall back to the disconnected implementation.
      return {
        connected: false,
        binary: DEFAULT_TUNE_AGENT_BINARY_PATH,
        admit: null,
        lastError: "no tune-agent binary at ~/.studiotune/tune-agent",
      };
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  };
  const stubWindow = {
    __TAURI__: {},
    __TAURI_INTERNALS__: { invoke },
  };
  await withStubbedWindow(stubWindow, async () => {
    const bridge = await loadTuneAgentBridge();
    assert.equal(bridge.getState().connected, false);
    // Even in disconnected mode, requestPlan must return null, never throw.
    const plan = await bridge.requestPlan("do the thing");
    assert.equal(plan, null);
  });
  assert.deepEqual(invocations, [
    {
      cmd: "tune_agent_start",
      args: { binary: DEFAULT_TUNE_AGENT_BINARY_PATH },
    },
  ]);
});

test("loader downgrades to disconnected when invoke throws (no Tauri IPC handler)", async () => {
  const invoke = async () => {
    throw new Error("ipc not initialized");
  };
  const stubWindow = {
    __TAURI__: {},
    __TAURI_INTERNALS__: { invoke },
  };
  await withStubbedWindow(stubWindow, async () => {
    const bridge = await loadTuneAgentBridge();
    assert.equal(bridge.getState().connected, false);
  });
});

test("live bridge downgrades to disconnected on a requestPlan invoke error", async () => {
  let planCalls = 0;
  const invoke = async (cmd: string) => {
    if (cmd === "tune_agent_request_plan") {
      planCalls += 1;
      throw new Error("sidecar died");
    }
    if (cmd === "tune_agent_set_mode") return undefined;
    throw new Error(`unexpected invoke: ${cmd}`);
  };
  const bridge = makeLiveTuneAgentBridge(invoke as never, {
    connected: true,
    binary: "/path",
    admit: null,
    lastError: null,
  });
  assert.equal(bridge.getState().connected, true);
  const plan = await bridge.requestPlan("hello");
  assert.equal(plan, null);
  assert.equal(planCalls, 1);
  assert.equal(
    bridge.getState().connected,
    false,
    "an invoke error must flip the rail back to disconnected — HOLD instead of a fake plan",
  );
});

test("live bridge stores plans returned from the sidecar", async () => {
  const plan: OutcomePlan = {
    id: "plan_1",
    summary: "Fine-tune on customer_support.jsonl",
    method: "LoRA",
    runtime: "mlx",
    dataset: "customer_support.jsonl",
    cost: "local-only",
    recipe: { steps: 500 },
  };
  const invoke = async (cmd: string) => {
    if (cmd === "tune_agent_request_plan") return plan;
    if (cmd === "tune_agent_set_mode") return undefined;
    throw new Error(`unexpected invoke: ${cmd}`);
  };
  const bridge = makeLiveTuneAgentBridge(invoke as never, {
    connected: true,
    binary: "/path",
    admit: null,
    lastError: null,
  });
  const got = await bridge.requestPlan("hello");
  assert.deepEqual(got, plan);
  assert.deepEqual(bridge.getState().plan, plan);
});

test("live bridge admitRuntime forwards python / snapshot / mlxArgs verbatim", async () => {
  const seen: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const outcome: TuneAgentAdmitOutcome = {
    admitted: true,
    python:
      "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13",
    snapshot:
      "~/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
    reason: null,
    hfHubOffline: "1",
  };
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    seen.push({ cmd, args });
    if (cmd === "tune_agent_admit_runtime") return outcome;
    throw new Error(`unexpected invoke: ${cmd}`);
  };
  const bridge = makeLiveTuneAgentBridge(invoke as never, {
    connected: true,
    binary: "/path",
    admit: null,
    lastError: null,
  });
  const admit = bridge.admitRuntime;
  assert.ok(admit, "live bridge must expose admitRuntime");
  const got = await admit({
    python: outcome.python,
    snapshot: outcome.snapshot,
    mlxArgs: [],
  });
  assert.deepEqual(got, outcome);
  assert.deepEqual(seen, [
    {
      cmd: "tune_agent_admit_runtime",
      args: {
        python: outcome.python,
        snapshot: outcome.snapshot,
        mlxArgs: [],
      },
    },
  ]);
  assert.equal(bridge.getState().runtimeAdmitted, true);
});

test("live bridge admitRuntime surfaces the host's refusal reason", async () => {
  const invoke = async (cmd: string) => {
    if (cmd === "tune_agent_admit_runtime") {
      throw new Error(
        "admit refused: host python at /usr/bin/python3 is not a regular file. The policy requires the framework build, not the python3 symlink.",
      );
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  };
  const bridge = makeLiveTuneAgentBridge(invoke as never, {
    connected: true,
    binary: "/path",
    admit: null,
    lastError: null,
  });
  const admit = bridge.admitRuntime;
  assert.ok(admit);
  const got = await admit({
    python: "/usr/bin/python3",
    snapshot: "~/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
    mlxArgs: [],
  });
  assert.equal(got?.admitted, false);
  assert.match(got?.reason ?? "", /not a regular file/);
  assert.equal(bridge.getState().runtimeAdmitted, false);
});

test("guards still hold with a live bridge in play", async () => {
  const invoke = async () => undefined as unknown;
  const bridge = makeLiveTuneAgentBridge(invoke as never, {
    connected: true,
    binary: "/path",
    admit: null,
    lastError: null,
  });
  // Accept: no plan → no-op, and no engine call anywhere.
  let engineCalls = 0;
  const result = applyPlanRecipe(bridge.getState().plan, (_recipe) => {
    engineCalls += 1;
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "no-plan");
  assert.equal(engineCalls, 0);

  // Plan mode cannot Train. Ask cannot either.
  bridge.setMode("plan");
  assert.equal(canStartTrainFromMode(bridge.getState().mode), false);

  // Agent mode without admit → refuse-close, with a reason string.
  bridge.setMode("agent");
  const admission = requireAdmittedRuntime(
    bridge.getState().mode,
    bridge.getState().runtimeAdmitted,
  );
  assert.equal(admission.admitted, false);
  if (!admission.admitted) {
    assert.match(admission.reason, /Agent mode/);
  }
});

test("disconnected bridge exposes admitRuntime as a null-returning refusal", async () => {
  const bridge = makeDisconnectedTuneAgentBridge("no-tauri");
  const admit = bridge.admitRuntime;
  assert.ok(admit, "disconnected bridge still exposes admitRuntime");
  const outcome = await admit({
    python:
      "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13",
    snapshot:
      "~/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
    mlxArgs: [],
  });
  assert.equal(
    outcome,
    null,
    "disconnected admitRuntime must return null so the rail draws HOLD instead of a fake admit",
  );
});
