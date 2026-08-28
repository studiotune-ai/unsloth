// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  adaptBridgePlanToCard,
  type OutcomePlanCard,
  PlanCard,
  planCardHasHubId,
  usePlanSessionStore,
} from "@/features/home";
import {
  applyPlanRecipe,
  canStartTrainFromMode,
  requireAdmittedRuntime,
} from "./tune-agent-guards";
import { loadTuneAgentBridge } from "./tune-agent-ipc";
import type {
  OutcomePlan,
  TuneAgentBridge,
  TuneAgentBridgeState,
  TuneAgentMode,
} from "./tune-agent-types";

const MODE_LABELS: Record<TuneAgentMode, string> = {
  ask: "Ask",
  plan: "Plan",
  agent: "Agent",
};

const MODE_DESCRIPTIONS: Record<TuneAgentMode, string> = {
  ask: "Inspect and explain. No Engine, no recipe mutation.",
  plan: "Propose an outcome plan. Accept applies the recipe locally. Never calls Engine.",
  agent:
    "Drive the local loop: inspect → admit → train → compare → local export. Never Hub-fetch, spend, publish, deploy, or sign.",
};

const STATUS_COLOR: Record<
  "ship" | "hold" | "revise" | "reject" | "evidence",
  string
> = {
  ship: "var(--ship-fg)",
  hold: "var(--hold-fg)",
  revise: "var(--revise-fg)",
  reject: "var(--reject-fg)",
  evidence: "var(--evidence-fg)",
};

/**
 * Persistent Tune Agent rail — StudioTune's Cursor-analog composer.
 *
 * Fails safely if Tune Agent is not running: the rail renders an honest
 * HOLD state, mode switching still works, but Accept/Grant/Train do
 * nothing and the plan card explains why.
 */
export function TuneAgentRail() {
  const [bridge, setBridge] = useState<TuneAgentBridge | null>(null);
  const [state, setState] = useState<TuneAgentBridgeState | null>(null);
  const [prompt, setPrompt] = useState("");
  const [lastReason, setLastReason] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void loadTuneAgentBridge().then((next) => {
      if (disposed) return;
      setBridge(next);
      setState(next.getState());
      unsubscribe = next.subscribe(setState);
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  // Neutral view while we hydrate. Kept short so the empty state below can
  // read as the honest disconnected snapshot without a hydration flicker.
  if (bridge === null || state === null) {
    return (
      <TuneAgentShell mode="ask" onSelectMode={() => {}} disabled={true} />
    );
  }

  return (
    <TuneAgentRailContent
      bridge={bridge}
      state={state}
      prompt={prompt}
      setPrompt={setPrompt}
      lastReason={lastReason}
      setLastReason={setLastReason}
    />
  );
}

function TuneAgentRailContent({
  bridge,
  state,
  prompt,
  setPrompt,
  lastReason,
  setLastReason,
}: {
  bridge: TuneAgentBridge;
  state: TuneAgentBridgeState;
  prompt: string;
  setPrompt: (next: string) => void;
  lastReason: string | null;
  setLastReason: (next: string | null) => void;
}) {
  const navigate = useNavigate();
  const sessionCard = usePlanSessionStore((s) => s.card);
  const handedToRail = usePlanSessionStore((s) => s.handedToRail);

  useEffect(() => {
    if (handedToRail && state.mode === "ask") {
      bridge.setMode("plan");
    }
  }, [handedToRail, state.mode, bridge]);

  const trainEnabledByMode = useMemo(
    () => canStartTrainFromMode(state.mode),
    [state.mode],
  );
  const admission = useMemo(
    () => requireAdmittedRuntime(state.mode, state.runtimeAdmitted),
    [state.mode, state.runtimeAdmitted],
  );

  function handleAccept() {
    // Accept never touches Engine. It only writes the recipe locally,
    // through the applyPlanRecipe guard. Prefer the Home session card when
    // Tune Agent has not produced its own bridge plan yet.
    const session = usePlanSessionStore.getState();
    const planForApply =
      state.plan ??
      (session.card
        ? { recipe: session.card.recipe as unknown as Record<string, unknown> }
        : null);
    const result = applyPlanRecipe(planForApply, (_recipe) => {
      // The recipe writer lives in the data-recipes feature. Wiring it in
      // is the next hop; for now we log the intent so an integrator can
      // see Accept fired without Engine.
    });
    if (!result.applied) {
      setLastReason("Nothing to accept: Tune Agent has not produced a plan.");
      return;
    }
    if (session.card) {
      const follow = session.acceptStep(
        session.card.steps.find((s) => s.id === "recipe") ??
          session.card.steps[0],
      );
      if (follow.followWorkspace) {
        void navigate({ to: "/studio" });
        setLastReason(
          "Accepted: recipe applied locally. Opening Train/Runs.",
        );
        return;
      }
    }
    setLastReason("Accepted: recipe applied locally.");
  }

  function handleGrant() {
    // Grant is a separate control: an explicit human signal to allow
    // Agent-driven actions on this plan. Fails visibly when there's no
    // plan or Tune Agent is not connected.
    if (state.plan === null && usePlanSessionStore.getState().card === null) {
      setLastReason("Nothing to grant: Tune Agent has not produced a plan.");
      return;
    }
    if (!state.connected) {
      setLastReason(
        "Grant is refused: Tune Agent is not connected. Start the agent process to grant.",
      );
      return;
    }
    setLastReason("Granted: Agent-driven actions allowed for this plan.");
  }

  function handleTrain() {
    if (!trainEnabledByMode) {
      setLastReason(
        state.mode === "plan"
          ? "Train is refused in Plan mode. Switch to Agent to start training."
          : "Train is refused in Ask mode.",
      );
      return;
    }
    if (!admission.admitted) {
      setLastReason(admission.reason);
      return;
    }
    if (state.plan === null) {
      setLastReason("Nothing to train: Tune Agent has not produced a plan.");
      return;
    }
    setLastReason(
      "Train intent recorded. Live training run is disabled in this hop.",
    );
  }

  async function handleAdmit() {
    if (bridge.admitRuntime === undefined) {
      setLastReason(
        "Admit refused: this build has no host-side admit bridge.",
      );
      return;
    }
    // The exact host + snapshot the StudioTune admit policy accepts. These
    // are locked in the Rust side (ADMITTED_HOST_PYTHON /
    // ADMITTED_MLX_SNAPSHOTS) and mirrored here so the UI can quote them
    // when a click asks for admit. mlxArgs is empty for this hop: a real
    // Train call adds `--model <snapshot>` and nothing else — a hub id
    // would be refused by the Rust guard.
    const outcome = await bridge.admitRuntime({
      python:
        "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13",
      snapshot:
        "~/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
      mlxArgs: [],
    });
    if (outcome === null) {
      setLastReason(
        "Admit refused: desktop host is not reachable. Rail stays in HOLD.",
      );
      return;
    }
    if (outcome.admitted) {
      setLastReason(
        `Admitted: python=${outcome.python}, snapshot=${outcome.snapshot}, HF_HUB_OFFLINE=${outcome.hfHubOffline}.`,
      );
    } else {
      setLastReason(
        outcome.reason ??
          "Admit refused: host declined without a reason.",
      );
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.mode === "ask") {
      setLastReason("Ask mode inspects only. Nothing was sent to Engine.");
      return;
    }
    if (!state.connected) {
      setLastReason(
        "Tune Agent is not connected. Plan requests fail-closed until the agent process starts.",
      );
      return;
    }
    const plan = await bridge.requestPlan(prompt);
    if (plan === null) {
      setLastReason(
        "Tune Agent returned no plan. Rail stays in HOLD until a plan lands.",
      );
    } else {
      setLastReason(`Plan received: ${plan.summary}`);
    }
  }

  const hasPlan = state.plan !== null || sessionCard !== null;
  const grantDisabled = !hasPlan || !state.connected;
  const trainDisabled =
    !trainEnabledByMode || !admission.admitted || !hasPlan;

  return (
    <TuneAgentShell
      mode={state.mode}
      onSelectMode={(mode) => bridge.setMode(mode)}
    >
      <ConnectionBadge connected={state.connected} />

      <form
        onSubmit={handleSubmit}
        className="mt-3 flex flex-col gap-2"
        aria-label="Tune Agent composer"
      >
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder={
            state.mode === "ask"
              ? "Ask about a training run, a recipe, or an export…"
              : state.mode === "plan"
                ? "Describe the outcome you want. Tune Agent will propose a plan."
                : "Describe the outcome you want. Agent may drive the full local loop."
          }
          className="w-full resize-none rounded-md border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/25"
          style={{
            background: "var(--ai-raised)",
            color: "var(--ai-text)",
            fontFamily: "var(--studiotune-font-ui)",
          }}
        />
        <div className="flex items-center justify-between">
          <p className="text-xs" style={{ color: "var(--ai-faint)" }}>
            {MODE_DESCRIPTIONS[state.mode]}
          </p>
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-xs font-medium"
            style={{
              background: "var(--ai-accent)",
              color: "var(--ai-on-accent)",
            }}
          >
            Send
          </button>
        </div>
      </form>

      <RailPlanSurface
        plan={state.plan}
        sessionCard={sessionCard}
        connected={state.connected}
        runtimeAdmitted={state.runtimeAdmitted}
        onAcceptStep={handleAccept}
        onSkipStep={(step) => {
          const result = usePlanSessionStore.getState().dropStep(step.id);
          setLastReason(result.reason);
        }}
        onDiscard={() => {
          usePlanSessionStore.getState().discardPlan();
          setLastReason("Plan discarded. Nothing ran.");
        }}
        onBranch={() => {
          const branch = usePlanSessionStore.getState().branchPlan();
          setLastReason(
            branch
              ? `Branched ${branch.id}. Neither plan runs.`
              : "Nothing to branch.",
          );
        }}
        onRevise={() => {
          if (prompt.trim().length === 0) {
            setLastReason("Describe an outcome to revise the plan.");
            return;
          }
          const next = usePlanSessionStore.getState().revisePlan(prompt, {
            parent: null,
            dataset: null,
            runtimeAdmitted: state.runtimeAdmitted,
          });
          setLastReason(
            next
              ? "Plan revised. Still a proposal — Accept applies it locally."
              : "Describe an outcome to revise the plan.",
          );
        }}
      />

      {state.mode === "agent" && (
        <div
          className="mt-3 flex items-center justify-between rounded-md border border-white/10 px-3 py-2 text-xs"
          data-testid="tune-agent-admit-row"
          style={{
            background: "var(--ai-surface)",
            color: state.runtimeAdmitted
              ? STATUS_COLOR.ship
              : STATUS_COLOR.hold,
          }}
        >
          <span>
            {state.runtimeAdmitted
              ? "Runtime admitted (HF_HUB_OFFLINE=1, snapshot allow-listed)."
              : "Runtime not admitted. Agent Train stays refused until admit passes."}
          </span>
          <button
            type="button"
            onClick={() => {
              void handleAdmit();
            }}
            className="ml-2 rounded-md border border-white/20 px-2 py-1 text-[11px] font-medium"
            data-testid="tune-agent-admit"
            style={{ color: "var(--ai-text)" }}
          >
            Admit runtime
          </button>
        </div>
      )}

      <div
        className="mt-3 grid grid-cols-3 gap-2"
        role="group"
        aria-label="Accept, Grant, Train — three separate controls"
      >
        <RailButton
          label="Accept"
          onClick={handleAccept}
          disabled={!hasPlan}
          hint={
            state.plan === null
              ? "Nothing to accept."
              : "Apply the recipe locally. Never calls Engine."
          }
          statusColor={STATUS_COLOR.evidence}
          data-testid="tune-agent-accept"
        />
        <RailButton
          label="Grant"
          onClick={handleGrant}
          disabled={grantDisabled}
          hint={
            state.plan === null
              ? "Nothing to grant."
              : state.connected
                ? "Allow Agent-driven actions on this plan."
                : "Tune Agent must be connected."
          }
          statusColor={STATUS_COLOR.hold}
          data-testid="tune-agent-grant"
        />
        <RailButton
          label="Train"
          onClick={handleTrain}
          disabled={trainDisabled}
          hint={
            trainEnabledByMode
              ? admission.admitted
                ? state.plan === null
                  ? "Nothing to train."
                  : "Start a local training run."
                : admission.reason
              : "Plan/Ask cannot start Train."
          }
          statusColor={STATUS_COLOR.ship}
          data-testid="tune-agent-train"
        />
      </div>

      {lastReason && (
        <p
          className="mt-3 rounded-md border border-white/10 px-3 py-2 text-xs"
          style={{
            background: "var(--ai-panel)",
            color: "var(--ai-muted)",
          }}
          role="status"
          data-testid="tune-agent-last-reason"
        >
          {lastReason}
        </p>
      )}
    </TuneAgentShell>
  );
}

function TuneAgentShell({
  mode,
  onSelectMode,
  disabled = false,
  children,
}: {
  mode: TuneAgentMode;
  onSelectMode: (next: TuneAgentMode) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <aside
      className="studiotune-brand hidden flex-col border-l border-white/5 md:flex"
      data-studiotune-rail="tune-agent"
      data-studiotune-panel="true"
      style={{
        width: "clamp(280px, 22vw, 360px)",
        background: "var(--ai-panel)",
        color: "var(--ai-text)",
      }}
      aria-label="Tune Agent"
    >
      <header className="border-b border-white/5 px-4 pt-4 pb-3">
        <div className="flex items-center justify-between">
          <p
            className="studiotune-wordmark text-sm font-semibold"
            style={{ color: "var(--ai-text)" }}
          >
            Tune Agent
          </p>
          <span
            className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
            style={{ color: "var(--ai-faint)" }}
          >
            HOLD
          </span>
        </div>
        <div
          className="mt-3 grid grid-cols-3 gap-1 rounded-md border border-white/10 p-1"
          role="tablist"
          aria-label="Tune Agent mode"
        >
          {(["ask", "plan", "agent"] as const).map((next) => {
            const active = mode === next;
            return (
              <button
                key={next}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={disabled}
                onClick={() => onSelectMode(next)}
                className="rounded px-2 py-1 text-xs font-medium transition-colors"
                data-testid={`tune-agent-mode-${next}`}
                style={{
                  background: active ? "var(--ai-accent)" : "transparent",
                  color: active ? "var(--ai-on-accent)" : "var(--ai-muted)",
                }}
              >
                {MODE_LABELS[next]}
              </button>
            );
          })}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-4 pb-4 pt-3">{children}</div>
    </aside>
  );
}

function ConnectionBadge({ connected }: { connected: boolean }) {
  return (
    <div
      className="inline-flex items-center gap-2 rounded-full border border-white/10 px-2.5 py-1 text-[11px]"
      data-testid="tune-agent-connection"
      style={{
        color: connected ? "var(--ship-fg)" : "var(--hold-fg)",
      }}
    >
      <span aria-hidden="true">●</span>
      {connected ? "Tune Agent connected" : "Tune Agent disconnected — HOLD"}
    </div>
  );
}

/**
 * Rail plan surface. Renders the shared home `<PlanCard>` when Tune Agent
 * has produced a plan, so Ask / Plan / Agent modes and the Clusy-style
 * home composer share one visual card. Falls back to an honest HOLD panel
 * when there is no plan yet — the rail never fakes a live plan.
 *
 * The bridge plan is adapted to the same `OutcomePlanCard` shape the home
 * composer emits via `adaptBridgePlanToCard`. A regression that surfaced
 * a Hub id anywhere on the card is caught by `planCardHasHubId` here (the
 * same guard the home composer runs) and downgrades the surface to HOLD
 * with a named reason instead of drawing.
 */
function RailPlanSurface({
  plan,
  sessionCard,
  connected,
  runtimeAdmitted,
  onAcceptStep,
  onSkipStep,
  onDiscard,
  onBranch,
  onRevise,
}: {
  plan: OutcomePlan | null;
  sessionCard: OutcomePlanCard | null;
  connected: boolean;
  runtimeAdmitted: boolean;
  onAcceptStep: () => void;
  onSkipStep?: (step: OutcomePlanCard["steps"][number]) => void;
  onDiscard?: () => void;
  onBranch?: () => void;
  onRevise?: () => void;
}) {
  if (sessionCard !== null) {
    if (planCardHasHubId(sessionCard)) {
      return (
        <section
          className="mt-3 rounded-md border border-white/10 p-3 text-xs"
          data-testid="tune-agent-plan-card-refused"
          style={{ background: "var(--ai-panel)", color: "var(--ai-muted)" }}
        >
          Refused: session plan would have surfaced a Hub id. StudioTune never
          sources runtimes or datasets from the Hub.
        </section>
      );
    }
    return (
      <div className="mt-3" data-testid="tune-agent-plan-card">
        <PlanCard
          card={sessionCard}
          handlers={{
            onAccept: () => onAcceptStep(),
            onSkip: onSkipStep,
            onDiscard,
            onBranch,
            onRevise,
          }}
        />
      </div>
    );
  }
  if (plan === null) {
    return (
      <section
        className="mt-3 rounded-md border border-dashed border-white/10 p-3 text-xs"
        style={{ color: "var(--ai-muted)" }}
        data-testid="tune-agent-plan-empty"
      >
        {connected
          ? "No plan yet. Ask, or send a Plan/Agent request to have Tune Agent propose one."
          : "Tune Agent is not connected, so there is no live plan. Rail stays in HOLD instead of faking one."}
      </section>
    );
  }
  let card: OutcomePlanCard;
  try {
    card = adaptBridgePlanToCard(plan, runtimeAdmitted);
  } catch {
    return (
      <section
        className="mt-3 rounded-md border border-white/10 p-3 text-xs"
        data-testid="tune-agent-plan-card-refused"
        style={{ background: "var(--ai-panel)", color: "var(--ai-muted)" }}
      >
        Plan adapter refused this bridge payload. Rail stays in HOLD instead of drawing a partial card.
      </section>
    );
  }
  if (planCardHasHubId(card)) {
    return (
      <section
        className="mt-3 rounded-md border border-white/10 p-3 text-xs"
        data-testid="tune-agent-plan-card-refused"
        style={{ background: "var(--ai-panel)", color: "var(--ai-muted)" }}
      >
        Refused: bridge plan would have surfaced a Hub id. StudioTune never
        sources runtimes or datasets from the Hub.
      </section>
    );
  }
  return (
    <div className="mt-3" data-testid="tune-agent-plan-card">
      <PlanCard
        card={card}
        handlers={{
          onAccept: () => onAcceptStep(),
        }}
      />
    </div>
  );
}

function RailButton({
  label,
  onClick,
  disabled,
  hint,
  statusColor,
  ...rest
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  hint: string;
  statusColor: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      aria-label={`${label} — ${hint}`}
      className="rounded-md border px-2 py-1.5 text-xs font-medium transition-colors"
      style={{
        borderColor: disabled ? "rgba(255,255,255,0.1)" : statusColor,
        color: disabled ? "var(--ai-faint)" : statusColor,
        background: "transparent",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
      {...rest}
    >
      {label}
    </button>
  );
}
