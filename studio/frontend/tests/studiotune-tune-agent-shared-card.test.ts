// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * Shared plan-card contract: the Tune Agent rail and the Clusy-style
 * one-prompt home composer render the SAME `PlanCard` component. This test
 * pins that wiring at the source level (Node's runner cannot load `.tsx`)
 * and unit-tests the adapter that converts a bridge `OutcomePlan` into the
 * `OutcomePlanCard` shape `PlanCard` renders.
 *
 * Locks:
 *   * The rail imports `PlanCard` from `@/features/home`, not from a local
 *     private copy.
 *   * The rail imports `adaptBridgePlanToCard` from the same module.
 *   * The rail asserts `planCardHasHubId` on the adapted card before drawing,
 *     mirroring the home composer's guard.
 *   * The adapter preserves bridge-supplied `method` / `runtime` / `cost` /
 *     `summary` when they are set, and falls back to the pure builder
 *     defaults when they are missing.
 *   * The adapter never lets a Hub id (`owner/name`) reach the card.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  adaptBridgePlanToCard,
  buildOutcomePlan,
  OUTCOME_PLAN_STEP_IDS,
  OUTCOME_PLAN_UNKNOWN,
  planCardHasHubId,
} from "../src/features/home/outcome-plan-builder.ts";

const RAIL_SOURCE = readFileSync(
  new URL("../src/features/tune-agent/tune-agent-rail.tsx", import.meta.url),
  "utf8",
);

test("Tune Agent rail imports the shared PlanCard from @/features/home", () => {
  // The rail must not carry a private plan card component — one card, one
  // set of testids, one accept-never-Engine contract across Ask/Plan/Agent
  // and the home composer.
  assert.match(
    RAIL_SOURCE,
    /from\s+["']@\/features\/home["']/,
    "tune-agent-rail must import from @/features/home",
  );
  assert.ok(
    /import\s*\{[^}]*\bPlanCard\b[^}]*\}\s*from\s*["']@\/features\/home["']/.test(
      RAIL_SOURCE,
    ),
    "tune-agent-rail must import PlanCard from the shared home barrel",
  );
  assert.ok(
    /import\s*\{[^}]*\badaptBridgePlanToCard\b[^}]*\}\s*from\s*["']@\/features\/home["']/.test(
      RAIL_SOURCE,
    ),
    "tune-agent-rail must import adaptBridgePlanToCard so bridge plans render on the same card",
  );
  assert.ok(
    /import\s*\{[^}]*\bplanCardHasHubId\b[^}]*\}\s*from\s*["']@\/features\/home["']/.test(
      RAIL_SOURCE,
    ),
    "tune-agent-rail must import planCardHasHubId to guard the rendered card",
  );
});

test("Tune Agent rail no longer defines a private PlanCard component", () => {
  // A `function PlanCard(` declaration inside the rail would mean two card
  // components diverging. The test-id `tune-agent-plan-card` is kept but
  // wraps the shared component now.
  assert.ok(
    !/function\s+PlanCard\s*\(/.test(RAIL_SOURCE),
    "tune-agent-rail must not declare a private PlanCard component",
  );
  assert.match(
    RAIL_SOURCE,
    /data-testid=["']tune-agent-plan-card["']/,
    "tune-agent-rail keeps the rail-scoped test id so integrators can still find the mounted card",
  );
});

test("Tune Agent rail keeps the honest-HOLD empty and refuse surfaces", () => {
  // The rail must still render a HOLD panel when Tune Agent has no plan or
  // when the adapter refuses a payload (Hub id, adapter throw). If any of
  // these surfaces disappeared, the rail could start rendering an inferred
  // card without a bridge plan.
  assert.match(
    RAIL_SOURCE,
    /data-testid=["']tune-agent-plan-empty["']/,
    "tune-agent-plan-empty surface must remain — no plan means HOLD, not a fake card",
  );
  assert.match(
    RAIL_SOURCE,
    /data-testid=["']tune-agent-plan-card-refused["']/,
    "tune-agent-plan-card-refused surface must remain — a Hub id must degrade to HOLD, not draw a partial card",
  );
});

test("adaptBridgePlanToCard preserves bridge-supplied header fields when set", () => {
  const card = adaptBridgePlanToCard(
    {
      id: "plan_bridge_1",
      summary: "Fine-tune Qwen 0.5B on /Users/me/data/support.jsonl",
      method: "QLoRA",
      runtime: "mlx",
      dataset: "/Users/me/data/support.jsonl",
      cost: "local-only",
      recipe: { steps: 500 },
    },
    true,
  );
  assert.equal(card.method, "QLoRA");
  assert.equal(card.runtime, "mlx");
  assert.equal(card.dataset, "/Users/me/data/support.jsonl");
  assert.equal(card.cost, "local-only");
  assert.equal(card.authority, false);
  assert.equal(card.action_taken, false);
  assert.equal(
    planCardHasHubId(card),
    false,
    "adapter must never surface a Hub id",
  );
});

test("adaptBridgePlanToCard falls back to the pure builder for missing fields", () => {
  const card = adaptBridgePlanToCard(
    {
      summary: "",
      recipe: {},
    },
    false,
  );
  // Empty summary + no dataset + no admit = fresh-install shape. The builder
  // fires all three clarifications; the adapter must reuse them, not paper
  // them over with fake defaults.
  const base = buildOutcomePlan("", {
    parent: null,
    dataset: null,
    runtimeAdmitted: false,
  });
  assert.equal(card.method, base.method);
  assert.equal(card.runtime, base.runtime);
  assert.equal(card.cost, base.cost);
  assert.equal(card.dataset, OUTCOME_PLAN_UNKNOWN);
  assert.deepEqual([...card.clarifications].sort(), [
    "missing-admit",
    "missing-dataset",
    "missing-parent",
  ]);
});

test("adaptBridgePlanToCard degrades a Hub id in dataset to UNKNOWN", () => {
  const card = adaptBridgePlanToCard(
    {
      summary: "train on HuggingFaceH4/no_robots",
      method: "LoRA",
      runtime: "mlx",
      dataset: "HuggingFaceH4/no_robots",
      cost: "local-only",
    },
    true,
  );
  assert.equal(
    card.dataset,
    OUTCOME_PLAN_UNKNOWN,
    "a Hub-shaped dataset must degrade to UNKNOWN, never surface on the card",
  );
  assert.ok(card.clarifications.includes("missing-dataset"));
  assert.equal(planCardHasHubId(card), false);
});

test("adaptBridgePlanToCard step list matches the shipped local loop order", () => {
  const card = adaptBridgePlanToCard(
    {
      summary: "fine-tune",
      method: "LoRA",
      runtime: "mlx",
      dataset: "/Users/me/data.jsonl",
      cost: "local-only",
    },
    true,
  );
  assert.deepEqual(
    card.steps.map((s) => s.id),
    [...OUTCOME_PLAN_STEP_IDS],
    "adapter must reuse the pinned local loop, not invent a new order",
  );
});

test("Rail source guards the adapted card with planCardHasHubId before render", () => {
  // Defence-in-depth mirror of the home composer: even after adapting, if
  // planCardHasHubId returns true, the rail must NOT render the card.
  assert.match(
    RAIL_SOURCE,
    /planCardHasHubId\s*\(/,
    "tune-agent-rail must call planCardHasHubId before drawing the adapted card",
  );
});

test("Rail source mounts the shared PlanCard element (not a local copy)", () => {
  // A regression that rendered a local <PlanCard /> defined in this file
  // would trip the earlier `function PlanCard(` test. But the JSX itself
  // must also mount the imported one — check that the JSX site is inside
  // the RailPlanSurface region and references the imported handlers prop.
  assert.match(
    RAIL_SOURCE,
    /<PlanCard\s+card=/,
    "tune-agent-rail must render <PlanCard card={...} />, the imported component's prop shape",
  );
  assert.match(
    RAIL_SOURCE,
    /handlers=\{\{\s*onAccept:/,
    "tune-agent-rail must pass an onAccept handler to the shared PlanCard",
  );
});
