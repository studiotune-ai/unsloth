// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

import type { OutcomePlan, TuneAgentMode } from "./tune-agent-types";

/**
 * Tune Agent — mode guards.
 *
 * Accept, Grant, and Train are three separate actions and this file makes
 * that split enforceable rather than only spelled out in the UI:
 *
 *  - `applyPlanRecipe` runs on Accept. It never calls Engine. It hands the
 *    plan's `recipe` payload back to a caller-supplied `applyRecipe`
 *    function which writes the recipe locally. Regressions where a code
 *    path accidentally invokes the Engine (parameter fitting, live training
 *    kickoff, etc.) show up as this function being asked to call something
 *    it never accepted.
 *
 *  - `canStartTrainFromMode` locks Plan-mode Train. Plan mode surfaces the
 *    plan card and lets the user Accept a recipe change, but it MUST NOT
 *    be able to start a training run. Only Agent mode may, and only after
 *    an admitted runtime (see `requireAdmittedRuntime`).
 *
 *  - `requireAdmittedRuntime` fail-closes Agent mode when the host has
 *    not admitted a runtime for this machine. Without an admitted runtime
 *    there is nowhere to run the loop, so Agent must refuse instead of
 *    silently falling back.
 */

/** Explicit type for the Accept handler so tests can assert on its shape. */
export type ApplyRecipeFn = (recipe: Record<string, unknown>) => void;

/**
 * Apply the plan's recipe locally on Accept. Never calls Engine. The caller
 * hands us both the plan and a local-only `applyRecipe` writer so that
 * this function's dependencies stay explicit — a future refactor that
 * quietly reaches for the Engine has to change the signature here first.
 */
export function applyPlanRecipe(
  plan: OutcomePlan | null,
  applyRecipe: ApplyRecipeFn,
): { applied: boolean; reason?: string } {
  if (plan === null) {
    return { applied: false, reason: "no-plan" };
  }
  applyRecipe(plan.recipe);
  return { applied: true };
}

/**
 * Whether the user is allowed to start a training run from a given mode.
 * The Plan-mode hard lock lives here.
 */
export function canStartTrainFromMode(mode: TuneAgentMode): boolean {
  switch (mode) {
    case "ask":
    case "plan":
      // Ask can only inspect. Plan can only propose + Accept a recipe
      // locally. Neither may start Train.
      return false;
    case "agent":
      // Agent may drive the local loop, but the runtime admission check in
      // `requireAdmittedRuntime` still has to pass before a run kicks off.
      return true;
    default: {
      const never: never = mode;
      // Exhaustive: newly added modes must be classified here.
      return never;
    }
  }
}

export type AgentRuntimeAdmission =
  | { admitted: true }
  | { admitted: false; reason: string };

/**
 * Fail-close Agent mode when runtime is not admitted. Ask/Plan don't run
 * training so they don't need admission. The caller uses the returned
 * reason to explain the refusal — the rail should never silently do
 * nothing on an Agent action that could not run.
 */
export function requireAdmittedRuntime(
  mode: TuneAgentMode,
  runtimeAdmitted: boolean,
): AgentRuntimeAdmission {
  if (mode !== "agent") {
    return { admitted: true };
  }
  if (!runtimeAdmitted) {
    return {
      admitted: false,
      reason:
        "Agent mode is refused until a runtime is admitted on this machine.",
    };
  }
  return { admitted: true };
}
