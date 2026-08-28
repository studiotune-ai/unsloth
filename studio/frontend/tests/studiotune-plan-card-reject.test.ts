// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

// AIN-952 / APP-010 — the PlanCard step row must expose an opt-in Reject
// label. The Home composer and the Tune Agent rail already wire Accept and
// Skip; Reject was the missing label. Enforced at the source level here,
// alongside the existing PlanCard source-level guards in
// studiotune-home-composer.test.ts.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PLAN_CARD_URL = new URL(
  "../src/features/home/plan-card.tsx",
  import.meta.url,
);

test("PlanCard step row exposes an opt-in Reject label wired through onReject", async () => {
  const src = await readFile(PLAN_CARD_URL, "utf8");

  assert.ok(
    src.includes("onReject?: (step: OutcomePlanStep) => void;"),
    "PlanCardHandlers must expose an optional onReject(step) handler",
  );

  assert.ok(
    src.includes('label="Reject"'),
    "PlanCard must render a Reject step button",
  );
  assert.ok(
    src.includes("home-plan-step-${step.id}-reject"),
    "Reject button must carry the home-plan-step-*-reject test id",
  );
  assert.ok(
    src.includes("Reject this step's proposal. Nothing persists"),
    "Reject hint must state it does not persist state or train",
  );
  assert.ok(
    src.includes("handlers?.onReject ?"),
    "Reject button must be opt-in (only rendered when handlers.onReject is wired)",
  );

  assert.ok(
    !/onReject[^}]*startTrain\(/.test(src),
    "Reject must not wire a startTrain call",
  );
  assert.ok(
    !/onReject[^}]*deleteRecipe\(/.test(src),
    "Reject must not delete persisted recipe rows",
  );
});

test("PlanCard Accept still advertises it is a local-only recipe bind", async () => {
  const src = await readFile(PLAN_CARD_URL, "utf8");
  assert.ok(src.includes("Accept applies the recipe locally"));
  assert.ok(src.includes("Never calls Engine"));
});
