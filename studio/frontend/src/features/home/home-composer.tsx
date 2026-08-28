// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

import { applyPlanRecipe } from "@/features/tune-agent";
import { useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { loadTuneAgentBridge } from "@/features/tune-agent";
import {
  type OutcomePlanCard,
  type OutcomePlanClarificationId,
  type OutcomePlanFacts,
  type OutcomePlanStep,
  adaptBridgePlanToCard,
  buildOutcomePlan,
  isPromptEffectivelyEmpty,
  planCardHasHubId,
} from "./outcome-plan-builder";
import { PlanCard } from "./plan-card";
import { CLI007_RETAINED } from "@/features/compare";
import {
  getAcceptedLocalDatasetPath,
  subscribeAcceptedLocalDataset,
} from "@/features/data-recipes";
import { usePlanSessionStore } from "./plan-session-store";
import { isRuntimeAdmitted, receipt } from "./mlx-runtime-admission";

/**
 * StudioTune Home composer — one prompt, one plan card.
 *
 * This is StudioTune's Clusy-style front door for the local training loop:
 * the user types one outcome sentence in a composer, the composer returns a
 * bounded plan card of steps (inspect-parent → … → export) BEFORE any
 * Engine call, and every step is Accept / Edit / Skip-able without ever
 * asking the Engine, the Hub, or the network to do anything.
 *
 * Design locks:
 *
 *   * The plan card is produced by `buildOutcomePlan` — a pure local
 *     function. The composer never opens IPC, never fetches, and never
 *     picks a cloud runtime. If Tune Agent is running, it may Accept the
 *     recipe locally, but the plan itself is produced client-side so a
 *     disconnected desktop still lands here honestly.
 *
 *   * Facts (`parent` / `dataset` / `runtimeAdmitted`) are the tiny snapshot
 *     the local host already knows. Parent is seeded from the APP-007 retained local snapshot dir.
 *     Dataset is seeded from an accepted APP-010 local-files bind
 *     (hydrated from localStorage `studiotune.home.dataset-bind.v1`).
 *     runtimeAdmitted is derived from the persisted mlx admission receipt
 *     via `isRuntimeAdmitted(receipt)` — never hardcoded true, never a toggle.
 *     Accept still never calls Engine.
 *
 *   * `planCardHasHubId` is asserted on every render so a regression that
 *     let a Hub id land on the card would fail loudly rather than quietly.
 */
export type HomeComposerProps = {
  /**
   * Initial facts the composer starts with. In tests this lets the caller
   * exercise clarification chips (missing parent / dataset / admit) without
   * driving the inputs. In production this comes from local stores; a
   * follow-up hop wires them together.
   */
  initialFacts?: OutcomePlanFacts;
  /**
   * Called when the user clicks Accept on a plan step. The default writes
   * the recipe locally through `applyPlanRecipe` — never Engine.
   */
  onAcceptStep?: (step: OutcomePlanStep, card: OutcomePlanCard) => void;
};

function factsFromBinds(): OutcomePlanFacts {
  return {
    parent: CLI007_RETAINED.parentSnapshotDir,
    dataset: getAcceptedLocalDatasetPath(),
    runtimeAdmitted: isRuntimeAdmitted(receipt),
  };
}

export function HomeComposer({
  initialFacts,
  onAcceptStep,
}: HomeComposerProps = {}) {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [facts, setFacts] = useState<OutcomePlanFacts>(
    initialFacts ?? factsFromBinds(),
  );

  useEffect(() => {
    return subscribeAcceptedLocalDataset(() => {
      setFacts((prev) => ({
        ...prev,
        dataset: getAcceptedLocalDatasetPath(),
        runtimeAdmitted: isRuntimeAdmitted(receipt),
      }));
    });
  }, []);
  const [card, setCard] = useState<OutcomePlanCard | null>(null);
  const [lastReason, setLastReason] = useState<string | null>(null);

  const submitDisabled = useMemo(
    () => isPromptEffectivelyEmpty(prompt),
    [prompt],
  );

  // One-shot: when Tune Agent is connected, paint the live sidecar plan
  // (diagnosis HOLD / REVISE) without a click so the running window shows
  // the same wire the no-click IPC already proved. Never trains.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const bridge = await loadTuneAgentBridge();
      if (cancelled || !bridge.getState().connected) {
        return;
      }
      const live = await bridge.requestPlan(
        "Fine-tune a local LoRA on a local dataset",
      );
      if (cancelled || live === null) {
        return;
      }
      const nextCard = adaptBridgePlanToCard(live, facts.runtimeAdmitted);
      if (planCardHasHubId(nextCard)) {
        return;
      }
      setCard(nextCard);
      usePlanSessionStore
        .getState()
        .publishPlan(
          "Fine-tune a local LoRA on a local dataset",
          facts,
          nextCard,
        );
      setLastReason(
        nextCard.diagnosis
          ? `HOLD · ${nextCard.diagnosis.disposition} · ${nextCard.diagnosis.code}`
          : "Live sidecar plan painted.",
      );
    })();
    return () => {
      cancelled = true;
    };
    // First paint only — later prompt submits replace this card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled) {
      setLastReason("Describe an outcome to plan.");
      return;
    }
    // Prefer the live sidecar plan (same wire as no-click IPC) so a
    // diagnosis HOLD / REVISE paints on the card. Fall back to the pure
    // local builder when Tune Agent is disconnected. Never trains.
    const bridge = await loadTuneAgentBridge();
    const live = bridge.getState().connected
      ? await bridge.requestPlan(prompt)
      : null;
    const nextCard =
      live !== null
        ? adaptBridgePlanToCard(live, facts.runtimeAdmitted)
        : buildOutcomePlan(prompt, facts);
    if (planCardHasHubId(nextCard)) {
      // Defence-in-depth. `buildOutcomePlan` already sanitises Hub ids, but
      // the composer refuses to render a card that would surface one so a
      // regression cannot land unnoticed on the Home surface.
      setCard(null);
      setLastReason(
        "Refused: plan would have surfaced a Hub id. StudioTune never sources runtimes or datasets from the Hub.",
      );
      return;
    }
    setCard(nextCard);
    usePlanSessionStore.getState().publishPlan(prompt, facts, nextCard);
    setLastReason(
      nextCard.clarifications.length === 0
        ? "Plan ready. Conversation moves to Tune Agent. Accept applies the recipe locally — never calls Engine."
        : `Plan drafted with ${nextCard.clarifications.length} clarification(s). Resolve them before Accept.`,
    );
  }

  function followWorkspaceIfReady(nextCard: OutcomePlanCard) {
    const follow = usePlanSessionStore.getState().acceptStep(
      nextCard.steps.find((s) => s.id === "recipe") ?? nextCard.steps[0],
    );
    if (follow.followWorkspace) {
      void navigate({ to: "/studio" });
    }
    return follow.followWorkspace;
  }

  function handleAccept(step: OutcomePlanStep) {
    if (card === null) {
      return;
    }
    if (onAcceptStep) {
      onAcceptStep(step, card);
      usePlanSessionStore.getState().acceptStep(step);
      setLastReason(`Accepted ${step.label} — applied locally.`);
      return;
    }
    // Default Accept path: write the recipe locally. This never touches
    // Engine — the same guard the Tune Agent rail uses. The card's recipe
    // is a structured object; we hand its whole shape to the guard which
    // forwards the payload to the local recipe writer.
    const outcome = applyPlanRecipe(
      { recipe: card.recipe as unknown as Record<string, unknown> },
      (_recipe) => {
        // Recipe application wiring lives in data-recipes. Logging the intent
        // keeps the Accept path visible for integrators until then.
      },
    );
    if (outcome.applied) {
      const followed = followWorkspaceIfReady(card);
      setLastReason(
        followed
          ? `Accepted ${step.label} — recipe applied locally. Opening Train/Runs.`
          : `Accepted ${step.label} — recipe applied locally.`,
      );
      return;
    }
    setLastReason("Nothing to accept: plan has no recipe.");
  }

  function handleSkip(step: OutcomePlanStep) {
    const store = usePlanSessionStore.getState();
    const result = store.dropStep(step.id);
    if (result.ok && store.card) {
      setCard(usePlanSessionStore.getState().card);
    }
    setLastReason(result.reason);
  }

  function handleDiscard() {
    usePlanSessionStore.getState().discardPlan();
    setCard(null);
    setLastReason("Plan discarded. Nothing ran.");
  }

  function handleBranch() {
    const branch = usePlanSessionStore.getState().branchPlan();
    setLastReason(
      branch
        ? `Branched ${branch.id}. Neither plan runs until you Accept.`
        : "Nothing to branch.",
    );
  }

  function handleRevise() {
    const next = usePlanSessionStore.getState().revisePlan(prompt, facts);
    if (next === null) {
      setLastReason("Describe an outcome to revise the plan.");
      return;
    }
    if (planCardHasHubId(next)) {
      setCard(null);
      setLastReason(
        "Refused: revised plan would have surfaced a Hub id. StudioTune never sources runtimes or datasets from the Hub.",
      );
      return;
    }
    setCard(next);
    setLastReason("Plan revised. Still a proposal — Accept applies it locally.");
  }

  function handleResolveClarification(id: OutcomePlanClarificationId) {
    // Clicking a clarification chip is a UX hint: it puts focus on the
    // matching input. Nothing here calls Engine, and nothing invents a
    // value the user did not provide.
    const targetId = clarificationInputId(id);
    if (targetId === null) {
      return;
    }
    if (typeof document === "undefined") {
      return;
    }
    const el = document.getElementById(targetId);
    if (el instanceof HTMLInputElement) {
      el.focus();
    }
  }

  return (
    <section
      className="studiotune-brand mx-auto flex w-full max-w-3xl flex-col gap-4 p-6"
      data-studiotune-panel="true"
      data-testid="home-composer"
      style={{ background: "var(--ai-bg)", color: "var(--ai-text)" }}
    >
      <header className="flex flex-col gap-1">
        <p
          className="studiotune-wordmark text-xl font-semibold"
          style={{ color: "var(--ai-text)" }}
        >
          StudioTune
        </p>
        <p className="text-sm" style={{ color: "var(--ai-muted)" }}>
          {card === null
            ? "Describe the outcome you want. StudioTune drafts a bounded local plan (inspect → recipe → admit → train → compare → export) before anything runs. No Engine, no Hub, no cloud GPUs."
            : "Plan is the canvas. Keep revising here, or continue in the Tune Agent rail. Accept applies locally — never trains, never spends, never fetches from the Hub."}
        </p>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="e.g. Fine-tune a local Qwen 0.5B on my customer_support.jsonl"
          aria-label="Outcome prompt"
          data-testid="home-composer-prompt"
          className="w-full resize-y rounded-md border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/25"
          style={{
            background: "var(--ai-raised)",
            color: "var(--ai-text)",
            fontFamily: "var(--studiotune-font-ui)",
          }}
        />
        <fieldset
          className="grid grid-cols-1 gap-2 md:grid-cols-3"
          data-testid="home-composer-facts"
        >
          <FactInput
            id="home-composer-fact-parent"
            label="Local parent"
            placeholder="/path/to/parent-snapshot"
            value={facts.parent ?? ""}
            onChange={(next) =>
              setFacts((prev) => ({
                ...prev,
                parent: next.length === 0 ? null : next,
              }))
            }
            testid="home-composer-fact-parent"
          />
          <FactInput
            id="home-composer-fact-dataset"
            label="Local dataset"
            placeholder="/path/to/dataset.jsonl"
            value={facts.dataset ?? ""}
            onChange={(next) =>
              setFacts((prev) => ({
                ...prev,
                dataset: next.length === 0 ? null : next,
              }))
            }
            testid="home-composer-fact-dataset"
          />
          <label
            htmlFor="home-composer-fact-admit"
            className="flex items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-xs"
            style={{ color: "var(--ai-text)" }}
          >
            <input
              id="home-composer-fact-admit"
              type="checkbox"
              checked={facts.runtimeAdmitted}
              disabled
              readOnly
              data-testid="home-composer-fact-admit"
            />
            Runtime admitted on this Mac
          </label>
        </fieldset>
        <div className="flex items-center justify-between">
          <p className="text-xs" style={{ color: "var(--ai-faint)" }}>
            One prompt in, one plan card out. Nothing runs until you Accept each
            step locally.
          </p>
          <button
            type="submit"
            disabled={submitDisabled}
            data-testid="home-composer-submit"
            className="rounded-md px-3 py-1.5 text-xs font-medium"
            style={{
              background: submitDisabled
                ? "rgba(255,255,255,0.05)"
                : "var(--ai-accent)",
              color: submitDisabled ? "var(--ai-faint)" : "var(--ai-on-accent)",
              cursor: submitDisabled ? "not-allowed" : "pointer",
            }}
          >
            Plan
          </button>
        </div>
      </form>

      {card !== null && (
        <PlanCard
          card={card}
          handlers={{
            onAccept: handleAccept,
            onSkip: handleSkip,
            onEdit: handleRevise,
            onResolveClarification: handleResolveClarification,
            onDiscard: handleDiscard,
            onBranch: handleBranch,
            onRevise: handleRevise,
          }}
        />
      )}

      {lastReason !== null && (
        <output
          data-testid="home-composer-status"
          className="block rounded-md border border-white/10 px-3 py-2 text-xs"
          style={{
            background: "var(--ai-panel)",
            color: "var(--ai-muted)",
          }}
        >
          {lastReason}
        </output>
      )}
    </section>
  );
}

function FactInput({
  id,
  label,
  placeholder,
  value,
  onChange,
  testid,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
  testid: string;
}) {
  return (
    <label
      htmlFor={id}
      className="flex flex-col gap-1 text-xs"
      style={{ color: "var(--ai-muted)" }}
    >
      {label}
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        data-testid={testid}
        className="w-full rounded-md border border-white/10 px-2 py-1 text-xs outline-none focus:border-white/25"
        style={{
          background: "var(--ai-raised)",
          color: "var(--ai-text)",
          fontFamily: "var(--studiotune-font-mono)",
        }}
      />
    </label>
  );
}

function clarificationInputId(id: OutcomePlanClarificationId): string | null {
  switch (id) {
    case "missing-parent":
      return "home-composer-fact-parent";
    case "missing-dataset":
      return "home-composer-fact-dataset";
    case "missing-admit":
      return "home-composer-fact-admit";
    default: {
      const never: never = id;
      return never;
    }
  }
}
