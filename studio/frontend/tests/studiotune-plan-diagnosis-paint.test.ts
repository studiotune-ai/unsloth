// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  adaptBridgePlanToCard,
  buildOutcomePlan,
  planCardHasHubId,
} from "../src/features/home/outcome-plan-builder.ts";

const PLAN_CARD_SOURCE = readFileSync(
  new URL("../src/features/home/plan-card.tsx", import.meta.url),
  "utf8",
);
const COMPOSER_SOURCE = readFileSync(
  new URL("../src/features/home/home-composer.tsx", import.meta.url),
  "utf8",
);

test("local builder cards have no diagnosis paint", () => {
  const card = buildOutcomePlan("Fine-tune a local LoRA", {
    parent: null,
    dataset: null,
    runtimeAdmitted: false,
  });
  assert.equal(card.diagnosis, null);
  assert.equal(card.authority, false);
  assert.equal(card.action_taken, false);
});

test("bridge diagnosis HOLD / REVISE paints on the shared card", () => {
  const card = adaptBridgePlanToCard(
    {
      summary: "request-verified-dataset-facts",
      method: "UNKNOWN",
      runtime: "UNKNOWN",
      dataset: "UNKNOWN",
      cost: "local-only",
      diagnosis: {
        disposition: "REVISE",
        code: "OUTCOME_PLAN_BLOCKED_BY_DIAGNOSIS",
        nextSafeAction: "request-verified-dataset-facts",
      },
    },
    false,
  );
  assert.equal(card.authority, false);
  assert.equal(card.action_taken, false);
  assert.equal(card.diagnosis?.disposition, "REVISE");
  assert.equal(card.diagnosis?.code, "OUTCOME_PLAN_BLOCKED_BY_DIAGNOSIS");
  assert.equal(planCardHasHubId(card), false);
});

test("PlanCard source renders the diagnosis banner and never a train method", () => {
  assert.match(PLAN_CARD_SOURCE, /data-testid=["']home-plan-diagnosis["']/);
  assert.match(PLAN_CARD_SOURCE, /authority=false/);
  assert.match(PLAN_CARD_SOURCE, /action_taken=false/);
  assert.equal(PLAN_CARD_SOURCE.includes("method:\"train\""), false);
});

test("Home composer prefers live requestPlan then local buildOutcomePlan", () => {
  assert.match(COMPOSER_SOURCE, /requestPlan/);
  assert.match(COMPOSER_SOURCE, /adaptBridgePlanToCard/);
  assert.match(COMPOSER_SOURCE, /buildOutcomePlan/);
  assert.equal(/tune_agent_train|method:\s*["']train["']/.test(COMPOSER_SOURCE), false);
});
