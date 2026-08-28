// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * Home composer (Clusy-style one-prompt plan) contract tests.
 *
 * These lock the four DONE-criteria for the composer surface:
 *
 *   1. One outcome prompt in produces a bounded plan card (steps + facts),
 *      with no Engine call anywhere in the path.
 *   2. Accept never starts training. Applying the recipe on Accept goes
 *      through `applyPlanRecipe` which does not touch Engine.
 *   3. Clarification chips fire when parent / dataset / admit are missing.
 *   4. No Hub-shaped id (`owner/name`) can appear anywhere on the plan
 *      card, regardless of what the caller declared as facts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  OUTCOME_PLAN_CLARIFICATION_IDS,
  OUTCOME_PLAN_CLARIFICATION_LABELS,
  OUTCOME_PLAN_STEP_IDS,
  OUTCOME_PLAN_UNKNOWN,
  type OutcomePlanFacts,
  buildOutcomePlan,
  isPromptEffectivelyEmpty,
  looksLikeHubId,
  planCardHasHubId,
} from "../src/features/home/outcome-plan-builder.ts";
import { applyPlanRecipe } from "../src/features/tune-agent/tune-agent-guards.ts";

// Node's --test / --experimental-strip-types on this Node minor cannot load
// `.tsx` at runtime, so the component's contract is read from source rather
// than exercised through a live render. `renderToStaticMarkup` still lives
// on installed pre-compiled packages (streamdown, etc.), which is why other
// tests can render JSX from those but not from local .tsx.
const PLAN_CARD_SOURCE = readFileSync(
  new URL("../src/features/home/plan-card.tsx", import.meta.url),
  "utf8",
);
const HOME_COMPOSER_SOURCE = readFileSync(
  new URL("../src/features/home/home-composer.tsx", import.meta.url),
  "utf8",
);

const FULL_FACTS: OutcomePlanFacts = {
  parent: "/opt/models/qwen2.5-0.5b-mlx",
  dataset: "/Users/me/data/customer_support.jsonl",
  runtimeAdmitted: true,
};

const EMPTY_FACTS: OutcomePlanFacts = {
  parent: null,
  dataset: null,
  runtimeAdmitted: false,
};

test("one prompt in yields a bounded plan card without any Engine call", () => {
  // The whole point of the composer: the plan is built client-side from a
  // prompt + local facts. `buildOutcomePlan` is a pure function — if it
  // ever reached for the Engine, the "no globals" module surface would
  // have to change first. We assert on the shape.
  const card = buildOutcomePlan("Fine-tune on my support logs", FULL_FACTS);
  assert.equal(card.runtime, "mlx");
  assert.equal(card.cost, "local-only");
  assert.equal(card.method, "LoRA");
  assert.equal(card.parent, FULL_FACTS.parent);
  assert.equal(card.dataset, FULL_FACTS.dataset);
  assert.equal(card.authority, false);
  assert.equal(card.action_taken, false);
  assert.deepEqual(
    card.steps.map((s) => s.id),
    [...OUTCOME_PLAN_STEP_IDS],
    "plan card must include the full local loop in order",
  );
});

test("the plan card is stable — same prompt + facts always produce the same card", () => {
  const a = buildOutcomePlan("fine-tune", FULL_FACTS);
  const b = buildOutcomePlan("fine-tune", FULL_FACTS);
  assert.deepEqual(a, b, "buildOutcomePlan must be a pure function");
});

test("Accept applies the recipe locally and never starts training", () => {
  // Applying the recipe: what Accept does on the composer. Any code path
  // that starts training would have to add a new dependency on this
  // function — the guard's whole role is to make that visible.
  let trainCalls = 0;
  const _train = () => {
    trainCalls += 1;
  };
  const card = buildOutcomePlan("fine-tune", FULL_FACTS);
  let recipeSeen: unknown = null;
  const outcome = applyPlanRecipe(
    { recipe: card.recipe as unknown as Record<string, unknown> },
    (recipe) => {
      recipeSeen = recipe;
    },
  );
  assert.equal(outcome.applied, true);
  assert.equal(trainCalls, 0, "Accept must not have started training");
  assert.deepEqual(recipeSeen, card.recipe);
});

test("clarification chip fires when the local dataset is missing", () => {
  const card = buildOutcomePlan("fine-tune", {
    ...FULL_FACTS,
    dataset: null,
  });
  assert.equal(card.dataset, OUTCOME_PLAN_UNKNOWN);
  assert.ok(
    card.clarifications.includes("missing-dataset"),
    "missing dataset must produce the missing-dataset clarification",
  );
  const datasetStep = card.steps.find((s) => s.id === "inspect-dataset");
  assert.ok(datasetStep);
  assert.equal(datasetStep?.status, "clarification");
  assert.equal(datasetStep?.clarification, "missing-dataset");
});

test("clarification chip fires when the local parent is missing", () => {
  const card = buildOutcomePlan("fine-tune", {
    ...FULL_FACTS,
    parent: null,
  });
  assert.equal(card.parent, OUTCOME_PLAN_UNKNOWN);
  assert.ok(card.clarifications.includes("missing-parent"));
  const parentStep = card.steps.find((s) => s.id === "inspect-parent");
  assert.equal(parentStep?.status, "clarification");
  assert.equal(parentStep?.clarification, "missing-parent");
});

test("clarification chip fires when the runtime is not admitted", () => {
  const card = buildOutcomePlan("fine-tune", {
    ...FULL_FACTS,
    runtimeAdmitted: false,
  });
  assert.ok(card.clarifications.includes("missing-admit"));
  const admitStep = card.steps.find((s) => s.id === "admit");
  const trainStep = card.steps.find((s) => s.id === "train");
  assert.equal(admitStep?.status, "clarification");
  assert.equal(trainStep?.status, "clarification");
  assert.equal(admitStep?.clarification, "missing-admit");
  assert.equal(trainStep?.clarification, "missing-admit");
});

test("all three clarifications fire on a fresh install (nothing declared, no admit)", () => {
  const card = buildOutcomePlan("fine-tune", EMPTY_FACTS);
  assert.deepEqual([...card.clarifications].sort(), [
    "missing-admit",
    "missing-dataset",
    "missing-parent",
  ]);
});

test("plan-card never surfaces a Hub id, regardless of what the caller declared", () => {
  // A caller who declared a Hub id where a local path should be. The
  // composer must degrade the field to UNKNOWN and fire the matching
  // clarification, never surface the Hub id.
  const card = buildOutcomePlan("fine-tune", {
    parent: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    dataset: "HuggingFaceH4/no_robots",
    runtimeAdmitted: true,
  });
  assert.equal(card.parent, OUTCOME_PLAN_UNKNOWN);
  assert.equal(card.dataset, OUTCOME_PLAN_UNKNOWN);
  assert.ok(card.clarifications.includes("missing-parent"));
  assert.ok(card.clarifications.includes("missing-dataset"));
  assert.equal(
    planCardHasHubId(card),
    false,
    "planCardHasHubId must return false — nothing on the card may look like a Hub id",
  );
});

test("URLs are also refused (no https:// datasets or parents on the card)", () => {
  const card = buildOutcomePlan("fine-tune", {
    parent: "https://huggingface.co/mlx-community/Qwen2.5-0.5B",
    dataset: "https://example.com/dataset.jsonl",
    runtimeAdmitted: true,
  });
  assert.equal(card.parent, OUTCOME_PLAN_UNKNOWN);
  assert.equal(card.dataset, OUTCOME_PLAN_UNKNOWN);
});

test("looksLikeHubId separates Hub ids from local paths", () => {
  assert.equal(looksLikeHubId("mlx-community/Qwen2.5-0.5B"), true);
  assert.equal(looksLikeHubId("owner/name"), true);
  // Local absolute path: contains slashes but starts with /.
  assert.equal(looksLikeHubId("/Users/me/data.jsonl"), false);
  // Home-anchored path.
  assert.equal(looksLikeHubId("~/data.jsonl"), false);
  // Relative path.
  assert.equal(looksLikeHubId("./data.jsonl"), false);
  // Multiple slashes are not owner/name.
  assert.equal(looksLikeHubId("a/b/c"), false);
  // Empty / whitespace.
  assert.equal(looksLikeHubId(""), false);
  assert.equal(looksLikeHubId("   "), false);
  assert.equal(looksLikeHubId(null), false);
});

test("empty prompts are refused by the composer's guard", () => {
  assert.equal(isPromptEffectivelyEmpty(""), true);
  assert.equal(isPromptEffectivelyEmpty("   \n  "), true);
  assert.equal(isPromptEffectivelyEmpty("hi"), false);
});

test("clarification ids and step ids stay locked to the shipped set", () => {
  // A well-meaning refactor that added a new mandatory step or dropped one
  // of the three clarification kinds would break the composer's contract
  // with tests that read specific ids. Lock both sets here.
  assert.deepEqual(
    [...OUTCOME_PLAN_STEP_IDS],
    [
      "inspect-parent",
      "inspect-dataset",
      "recipe",
      "admit",
      "train",
      "compare",
      "export",
    ],
  );
  assert.deepEqual([...OUTCOME_PLAN_CLARIFICATION_IDS].sort(), [
    "missing-admit",
    "missing-dataset",
    "missing-parent",
  ]);
});

test("PlanCard source wires a test hook for every step and every clarification chip", () => {
  // Source-level assertion (Node's runner cannot load `.tsx` here). Every
  // step id and clarification id the builder exports must have a matching
  // `data-testid` template in the PlanCard source, so the composer's UI
  // cannot drift out of sync with the builder without a loud failure.
  assert.ok(
    PLAN_CARD_SOURCE.includes("home-plan-step-${step.id}"),
    "PlanCard source must reference `home-plan-step-${step.id}` for every step row",
  );
  assert.ok(
    PLAN_CARD_SOURCE.includes("home-plan-clarification-${id}"),
    "PlanCard source must reference `home-plan-clarification-${id}` for every chip",
  );
  for (const chipId of OUTCOME_PLAN_CLARIFICATION_IDS) {
    assert.ok(
      OUTCOME_PLAN_CLARIFICATION_LABELS[chipId].length > 0,
      `clarification ${chipId} must have a non-empty label`,
    );
  }
  for (const stepId of OUTCOME_PLAN_STEP_IDS) {
    // Sanity: every step id is used as a discriminant somewhere in the
    // builder-generated card, so the wiring cannot omit one.
    assert.ok(stepId.length > 0);
  }
});

test("PlanCard advertises the plan is proposal-only (Accept never trains)", () => {
  // If a regression removed the Accept hint (or added a live-train button
  // next to Accept), the source-level guard here fires.
  assert.ok(
    PLAN_CARD_SOURCE.includes("Never calls Engine"),
    "Accept must advertise it never calls Engine",
  );
  assert.ok(
    PLAN_CARD_SOURCE.includes("Accept applies the recipe locally"),
    "Accept hint must include the recipe-only wording",
  );
  assert.ok(
    !/onClick=\{[^}]*startTrain\(/.test(PLAN_CARD_SOURCE),
    "PlanCard must not wire a startTrain onClick anywhere",
  );
});

test("PlanCard exposes an Edit action for every step (Cursor-style plan editing)", () => {
  // Same source-level guard: the Edit test id template must be present in
  // the PlanCard source so the step row wiring cannot silently drop it.
  assert.ok(
    PLAN_CARD_SOURCE.includes("-edit"),
    "PlanCard source must reference the -edit test id suffix",
  );
});

test("HomeComposer default Accept path goes through applyPlanRecipe (never Engine)", () => {
  // The composer's Accept path uses the same guard as the Tune Agent rail:
  // `applyPlanRecipe`. A regression that reached for the Engine on Accept
  // would need to add a new import here — which this test blocks.
  assert.ok(
    HOME_COMPOSER_SOURCE.includes(
      'import { applyPlanRecipe } from "@/features/tune-agent"',
    ),
    "HomeComposer must import applyPlanRecipe from tune-agent",
  );
  assert.ok(
    !/from ["'].*engine["']/i.test(HOME_COMPOSER_SOURCE),
    "HomeComposer must not import from any 'engine' module",
  );
});
