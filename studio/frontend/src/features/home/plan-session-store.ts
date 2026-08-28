// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * Shared Home ↔ Tune Agent plan session (Clusy-adapted, local-only).
 *
 * The first prompt lives on Home. Once a plan card exists, the conversation
 * moves into the Tune Agent rail and this store is the single canvas both
 * surfaces read. Nothing here calls Engine, the Hub, or a cloud GPU.
 *
 *   * publishPlan  — Home composer produced a card. Rail switches to Plan.
 *   * discardPlan  — drop the active plan. Neither branch runs.
 *   * dropStep     — Skip an optional step on this revision (mandatory
 *                    local-loop steps stay locked).
 *   * acceptStep   — Accept ≠ Grant ≠ Train. Recipe-only. After Accept on a
 *                    clarification-free plan, followWorkspace becomes true
 *                    so the UI can leave the plan tab for Models/Data/Train.
 *   * revisePlan   — rebuild from an edited prompt. Still a proposal.
 *   * branchPlan   — Clusy branch/fork, local only: a second plan sits next
 *                    to the first. Neither plan runs.
 */

import { create } from "zustand";

import {
  buildOutcomePlan,
  isPromptEffectivelyEmpty,
  type OutcomePlanCard,
  type OutcomePlanFacts,
  type OutcomePlanStep,
  type OutcomePlanStepId,
} from "./outcome-plan-builder.ts";

export type PlanBranch = {
  id: string;
  prompt: string;
  card: OutcomePlanCard;
};

export type PlanSessionState = {
  prompt: string;
  facts: OutcomePlanFacts;
  card: OutcomePlanCard | null;
  skippedStepIds: OutcomePlanStepId[];
  acceptedStepIds: OutcomePlanStepId[];
  branches: PlanBranch[];
  handedToRail: boolean;
  followWorkspace: boolean;
  nextBranchSerial: number;
};

const EMPTY_FACTS: OutcomePlanFacts = {
  parent: null,
  dataset: null,
  runtimeAdmitted: false,
};

export const EMPTY_PLAN_SESSION: PlanSessionState = {
  prompt: "",
  facts: EMPTY_FACTS,
  card: null,
  skippedStepIds: [],
  acceptedStepIds: [],
  branches: [],
  handedToRail: false,
  followWorkspace: false,
  nextBranchSerial: 1,
};

/**
 * Drop (Skip) an optional step from this revision. Mandatory local-loop
 * steps cannot be dropped — that is the structural Plan lock.
 */
export function skipOptionalStep(
  card: OutcomePlanCard,
  stepId: OutcomePlanStepId,
): { ok: true; card: OutcomePlanCard } | { ok: false; reason: string } {
  const step = card.steps.find((s) => s.id === stepId);
  if (!step) {
    return { ok: false, reason: `Unknown step ${stepId}` };
  }
  if (step.status !== "optional") {
    return {
      ok: false,
      reason: "This step is part of the local loop and cannot be dropped.",
    };
  }
  return {
    ok: true,
    card: {
      ...card,
      recipe: {
        ...card.recipe,
        ready_step_ids: card.recipe.ready_step_ids.filter((id) => id !== stepId),
      },
    },
  };
}

/**
 * Clone a plan as a second proposal. Authority and action_taken stay false
 * so branching never runs either plan.
 */
export function branchFromPlan(card: OutcomePlanCard): OutcomePlanCard {
  return {
    ...card,
    authority: false,
    action_taken: false,
    recipe: {
      prompt: card.recipe.prompt,
      ready_step_ids: [...card.recipe.ready_step_ids],
    },
    steps: card.steps.map((step) => ({ ...step })),
    clarifications: [...card.clarifications],
  };
}

/** After Accept, the UI may follow into the experiment workspace. */
export function planAllowsFollowWorkspace(card: OutcomePlanCard): boolean {
  return card.clarifications.length === 0 && card.action_taken === false;
}

export type PlanSessionActions = {
  publishPlan: (
    prompt: string,
    facts: OutcomePlanFacts,
    card: OutcomePlanCard,
  ) => void;
  discardPlan: () => void;
  dropStep: (stepId: OutcomePlanStepId) => { ok: boolean; reason: string };
  acceptStep: (step: OutcomePlanStep) => { followWorkspace: boolean };
  revisePlan: (
    prompt: string,
    facts: OutcomePlanFacts,
  ) => OutcomePlanCard | null;
  branchPlan: () => PlanBranch | null;
  reset: () => void;
};

export const usePlanSessionStore = create<
  PlanSessionState & PlanSessionActions
>((set, get) => ({
  ...EMPTY_PLAN_SESSION,
  publishPlan: (prompt, facts, card) =>
    set({
      prompt,
      facts,
      card,
      skippedStepIds: [],
      acceptedStepIds: [],
      handedToRail: true,
      followWorkspace: false,
    }),
  discardPlan: () =>
    set({
      card: null,
      skippedStepIds: [],
      acceptedStepIds: [],
      handedToRail: false,
      followWorkspace: false,
    }),
  dropStep: (stepId) => {
    const { card, skippedStepIds } = get();
    if (!card) {
      return { ok: false, reason: "No plan to drop a step from." };
    }
    const result = skipOptionalStep(card, stepId);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    set({
      card: result.card,
      skippedStepIds: [...skippedStepIds, stepId],
    });
    return { ok: true, reason: `Dropped ${stepId} from this plan revision.` };
  },
  acceptStep: (step) => {
    const { card, acceptedStepIds } = get();
    if (!card) {
      return { followWorkspace: false };
    }
    const shouldFollow = planAllowsFollowWorkspace(card);
    set({
      acceptedStepIds: [...acceptedStepIds, step.id],
      followWorkspace: shouldFollow,
    });
    return { followWorkspace: shouldFollow };
  },
  revisePlan: (prompt, facts) => {
    if (isPromptEffectivelyEmpty(prompt)) {
      return null;
    }
    const card = buildOutcomePlan(prompt, facts);
    set({
      prompt: prompt.trim(),
      facts,
      card,
      skippedStepIds: [],
      acceptedStepIds: [],
      handedToRail: true,
      followWorkspace: false,
    });
    return card;
  },
  branchPlan: () => {
    const { card, prompt, nextBranchSerial, branches } = get();
    if (!card) {
      return null;
    }
    const entry: PlanBranch = {
      id: `branch_${nextBranchSerial}`,
      prompt,
      card: branchFromPlan(card),
    };
    set({
      branches: [...branches, entry],
      nextBranchSerial: nextBranchSerial + 1,
    });
    return entry;
  },
  reset: () => set({ ...EMPTY_PLAN_SESSION }),
}));
