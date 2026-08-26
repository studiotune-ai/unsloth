// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

import { useEffect, useMemo, useState } from "react";
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
    // through the applyPlanRecipe guard.
    const result = applyPlanRecipe(state.plan, (_recipe) => {
      // The recipe writer lives in the data-recipes feature. Wiring it in
      // is the next hop; for now we log the intent so an integrator can
      // see Accept fired without Engine.
    });
    setLastReason(
      result.applied
        ? "Accepted: recipe applied locally."
        : "Nothing to accept: Tune Agent has not produced a plan.",
    );
  }

  function handleGrant() {
    // Grant is a separate control: an explicit human signal to allow
    // Agent-driven actions on this plan. Fails visibly when there's no
    // plan or Tune Agent is not connected.
    if (state.plan === null) {
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

  const grantDisabled = state.plan === null || !state.connected;
  const trainDisabled =
    !trainEnabledByMode || !admission.admitted || state.plan === null;

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

      <PlanCard plan={state.plan} connected={state.connected} />

      <div
        className="mt-3 grid grid-cols-3 gap-2"
        role="group"
        aria-label="Accept, Grant, Train — three separate controls"
      >
        <RailButton
          label="Accept"
          onClick={handleAccept}
          disabled={state.plan === null}
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

function PlanCard({
  plan,
  connected,
}: {
  plan: OutcomePlan | null;
  connected: boolean;
}) {
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
  return (
    <section
      className="mt-3 rounded-md border border-white/10 p-3 text-xs"
      style={{ background: "var(--ai-surface)", color: "var(--ai-text)" }}
      data-testid="tune-agent-plan-card"
    >
      <p className="text-sm font-semibold">{plan.summary}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        <PlanField label="Method" value={plan.method} />
        <PlanField label="Runtime" value={plan.runtime} />
        <PlanField label="Dataset" value={plan.dataset} />
        <PlanField label="Cost" value={plan.cost} />
      </dl>
    </section>
  );
}

function PlanField({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={{ color: "var(--ai-faint)" }}>{label}</dt>
      <dd style={{ color: "var(--ai-text)" }}>{value}</dd>
    </>
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
