// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * Clusy-adapted plan session (local-only) contract.
 *
 * Locks the UX stolen from clusy.io without copying their notebook, Hub,
 * GPUs, or billing:
 *
 *   1. First prompt publishes a plan and hands the conversation to the rail.
 *   2. Plan is its own card: revise / drop / discard stay Engine-free.
 *   3. Accept never trains. followWorkspace is the only "leave the plan tab"
 *      signal, and only after a clarification-free Accept.
 *   4. branch_from creates a second plan without running either.
 *   5. Hub ids still cannot appear.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildOutcomePlan,
  planCardHasHubId,
  type OutcomePlanFacts,
} from "../src/features/home/outcome-plan-builder.ts";
import {
  branchFromPlan,
  planAllowsFollowWorkspace,
  skipOptionalStep,
  usePlanSessionStore,
} from "../src/features/home/plan-session-store.ts";

const FULL_FACTS: OutcomePlanFacts = {
  parent: "/opt/models/qwen2.5-0.5b-mlx",
  dataset: "/Users/me/data/customer_support.jsonl",
  runtimeAdmitted: true,
};

const COMPOSER = readFileSync(
  new URL("../src/features/home/home-composer.tsx", import.meta.url),
  "utf8",
);
const RAIL = readFileSync(
  new URL("../src/features/tune-agent/tune-agent-rail.tsx", import.meta.url),
  "utf8",
);
const CARD = readFileSync(
  new URL("../src/features/home/plan-card.tsx", import.meta.url),
  "utf8",
);

test.beforeEach(() => {
  usePlanSessionStore.getState().reset();
});

test("publishing a plan hands the conversation to the Tune Agent rail", () => {
  const card = buildOutcomePlan("Fine-tune on my support logs", FULL_FACTS);
  usePlanSessionStore.getState().publishPlan("Fine-tune on my support logs", FULL_FACTS, card);
  const state = usePlanSessionStore.getState();
  assert.equal(state.handedToRail, true);
  assert.equal(state.followWorkspace, false);
  assert.equal(state.card?.authority, false);
  assert.equal(state.card?.action_taken, false);
  assert.equal(planCardHasHubId(state.card!), false);
});

test("drop refuses a mandatory local-loop step and allows an optional one", () => {
  const card = buildOutcomePlan("fine-tune", FULL_FACTS);
  const refused = skipOptionalStep(card, "train");
  assert.equal(refused.ok, false);
  const dropped = skipOptionalStep(card, "export");
  assert.equal(dropped.ok, true);
  if (dropped.ok) {
    assert.ok(!dropped.card.recipe.ready_step_ids.includes("export"));
    assert.equal(dropped.card.action_taken, false);
  }
});

test("discard clears the active plan and does not run anything", () => {
  const card = buildOutcomePlan("fine-tune", FULL_FACTS);
  const store = usePlanSessionStore.getState();
  store.publishPlan("fine-tune", FULL_FACTS, card);
  store.discardPlan();
  const after = usePlanSessionStore.getState();
  assert.equal(after.card, null);
  assert.equal(after.handedToRail, false);
  assert.equal(after.followWorkspace, false);
  assert.equal(after.acceptedStepIds.length, 0);
});

test("Accept on a clarification-free plan sets followWorkspace (never trains)", () => {
  const card = buildOutcomePlan("fine-tune", FULL_FACTS);
  assert.equal(planAllowsFollowWorkspace(card), true);
  const store = usePlanSessionStore.getState();
  store.publishPlan("fine-tune", FULL_FACTS, card);
  const trainStep = card.steps.find((s) => s.id === "recipe");
  assert.ok(trainStep);
  const outcome = store.acceptStep(trainStep!);
  assert.equal(outcome.followWorkspace, true);
  assert.equal(usePlanSessionStore.getState().followWorkspace, true);
  assert.equal(card.action_taken, false);
});

test("Accept on a blocked plan does not follow into the workspace", () => {
  const card = buildOutcomePlan("fine-tune", {
    parent: null,
    dataset: null,
    runtimeAdmitted: false,
  });
  assert.equal(planAllowsFollowWorkspace(card), false);
  usePlanSessionStore.getState().publishPlan("fine-tune", {
    parent: null,
    dataset: null,
    runtimeAdmitted: false,
  }, card);
  const recipe = card.steps.find((s) => s.id === "recipe");
  assert.ok(recipe);
  const outcome = usePlanSessionStore.getState().acceptStep(recipe!);
  assert.equal(outcome.followWorkspace, false);
});

test("branch_from creates a second plan without running either", () => {
  const card = buildOutcomePlan("fine-tune", FULL_FACTS);
  const store = usePlanSessionStore.getState();
  store.publishPlan("fine-tune", FULL_FACTS, card);
  const branch = store.branchPlan();
  assert.ok(branch);
  assert.equal(branch?.id, "branch_1");
  assert.equal(branch?.card.authority, false);
  assert.equal(branch?.card.action_taken, false);
  const after = usePlanSessionStore.getState();
  assert.equal(after.card?.action_taken, false);
  assert.equal(after.branches.length, 1);
  assert.deepEqual(branchFromPlan(card).recipe, card.recipe);
});

test("revise rebuilds a proposal from a new prompt and stays Engine-free", () => {
  const store = usePlanSessionStore.getState();
  store.publishPlan(
    "fine-tune",
    FULL_FACTS,
    buildOutcomePlan("fine-tune", FULL_FACTS),
  );
  const revised = store.revisePlan("QLoRA on my local support logs", FULL_FACTS);
  assert.ok(revised);
  assert.equal(revised?.method, "QLoRA");
  assert.equal(revised?.authority, false);
  assert.equal(revised?.action_taken, false);
  assert.equal(usePlanSessionStore.getState().followWorkspace, false);
});

test("Home composer publishes to the shared session and follows /studio after Accept", () => {
  assert.match(
    COMPOSER,
    /usePlanSessionStore/,
    "HomeComposer must publish into the shared plan session",
  );
  assert.match(
    COMPOSER,
    /to:\s*["']\/studio["']/,
    "After Accept, HomeComposer must follow into the experiment workspace /studio",
  );
  assert.ok(
    !/from ["'].*engine["']/i.test(COMPOSER),
    "HomeComposer must not import Engine",
  );
});

test("Tune Agent rail consumes the shared session PlanCard (Clusy canvas)", () => {
  assert.match(
    RAIL,
    /usePlanSessionStore/,
    "tune-agent-rail must read the shared plan session",
  );
  assert.match(
    RAIL,
    /handedToRail/,
    "rail must notice when Home handed the conversation over",
  );
});

test("PlanCard exposes Discard, Branch, and Revise without a train control", () => {
  assert.match(CARD, /onDiscard/, "PlanCard must accept an onDiscard handler");
  assert.match(CARD, /onBranch/, "PlanCard must accept an onBranch handler");
  assert.match(CARD, /onRevise/, "PlanCard must accept an onRevise handler");
  assert.ok(
    CARD.includes("Never calls Engine"),
    "Accept must still advertise it never calls Engine",
  );
  assert.ok(
    !/onClick=\{[^}]*startTrain\(/.test(CARD),
    "PlanCard must not wire a startTrain onClick",
  );
});
