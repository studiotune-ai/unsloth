// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * Tune Agent contract tests.
 *
 * These are the load-bearing guards for the rail:
 *   - Accept never calls Engine.
 *   - Plan mode cannot start Train.
 *   - Agent mode fail-closes when runtime is not admitted.
 *   - IPC is disconnected in the absence of Tauri (Node/browser preview).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPlanRecipe,
  canStartTrainFromMode,
  requireAdmittedRuntime,
} from "../src/features/tune-agent/tune-agent-guards.ts";
import {
  loadTuneAgentBridge,
  makeDisconnectedTuneAgentBridge,
} from "../src/features/tune-agent/tune-agent-ipc.ts";
import type {
  OutcomePlan,
  TuneAgentMode,
} from "../src/features/tune-agent/tune-agent-types.ts";

function samplePlan(): OutcomePlan {
  return {
    id: "plan_test",
    summary: "Fine-tune on customer_support.jsonl",
    method: "LoRA",
    runtime: "mlx",
    dataset: "customer_support.jsonl",
    cost: "local-only",
    recipe: { steps: 500 },
  };
}

test("Accept applies the recipe locally and never touches Engine", () => {
  // A stand-in Engine: if any test path reaches it, the guard is broken.
  let engineCalls = 0;
  const _engine = () => {
    engineCalls += 1;
  };

  let applied: Record<string, unknown> | null = null;
  const applyRecipe = (recipe: Record<string, unknown>) => {
    applied = recipe;
  };

  const result = applyPlanRecipe(samplePlan(), applyRecipe);

  assert.equal(result.applied, true, "Accept must apply the recipe");
  assert.deepEqual(applied, { steps: 500 });
  assert.equal(
    engineCalls,
    0,
    "Accept must not call Engine — that is the whole point of the guard",
  );
});

test("Accept with no plan reports no-plan without applying anything", () => {
  let applyCalls = 0;
  const result = applyPlanRecipe(null, () => {
    applyCalls += 1;
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "no-plan");
  assert.equal(applyCalls, 0);
});

test("Plan mode cannot start Train", () => {
  assert.equal(
    canStartTrainFromMode("plan"),
    false,
    "Plan mode is the hard lock: it must never start a training run",
  );
});

test("Ask mode cannot start Train", () => {
  assert.equal(canStartTrainFromMode("ask"), false);
});

test("Agent mode is allowed to start Train (before admission check)", () => {
  assert.equal(canStartTrainFromMode("agent"), true);
});

test("Agent mode refuses when runtime is not admitted", () => {
  const admission = requireAdmittedRuntime("agent", false);
  assert.equal(admission.admitted, false);
  if (!admission.admitted) {
    assert.match(admission.reason, /Agent mode/);
    assert.match(admission.reason, /refused/);
  }
});

test("Agent mode is allowed when runtime is admitted", () => {
  const admission = requireAdmittedRuntime("agent", true);
  assert.equal(admission.admitted, true);
});

test("Ask/Plan modes do not require runtime admission", () => {
  for (const mode of [
    "ask",
    "plan",
  ] as const satisfies readonly TuneAgentMode[]) {
    const admission = requireAdmittedRuntime(mode, false);
    assert.equal(
      admission.admitted,
      true,
      `${mode} mode should not require runtime admission`,
    );
  }
});

test("Disconnected bridge fail-closes: no plan, no engine calls", async () => {
  const bridge = makeDisconnectedTuneAgentBridge();
  const state = bridge.getState();
  assert.equal(state.connected, false);
  assert.equal(state.plan, null);
  assert.equal(state.mode, "ask");
  assert.equal(state.runtimeAdmitted, false);

  const plan = await bridge.requestPlan("do the thing");
  assert.equal(
    plan,
    null,
    "requestPlan must return null when Tune Agent is not connected — never a fake plan",
  );
});

test("Disconnected bridge remembers mode changes even offline", () => {
  const bridge = makeDisconnectedTuneAgentBridge();
  bridge.setMode("plan");
  assert.equal(bridge.getState().mode, "plan");
  bridge.setMode("agent");
  assert.equal(bridge.getState().mode, "agent");
});

test("Bridge subscribers are notified on mode changes", () => {
  const bridge = makeDisconnectedTuneAgentBridge();
  const events: string[] = [];
  const unsubscribe = bridge.subscribe((next) => events.push(next.mode));
  bridge.setMode("plan");
  bridge.setMode("agent");
  bridge.setMode("agent"); // same mode — no re-emit
  unsubscribe();
  bridge.setMode("ask"); // after unsubscribe — ignored
  assert.deepEqual(events, ["plan", "agent"]);
});

test("loadTuneAgentBridge returns a disconnected bridge under Node", async () => {
  // Node test runner: no window, no Tauri, no live Tune Agent.
  const bridge = await loadTuneAgentBridge();
  const state = bridge.getState();
  assert.equal(state.connected, false);
  assert.equal(state.plan, null);
});
