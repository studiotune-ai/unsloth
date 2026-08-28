// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

import type {
  OutcomePlanCard,
  OutcomePlanClarificationId,
  OutcomePlanStep,
} from "./outcome-plan-builder";
import { OUTCOME_PLAN_CLARIFICATION_LABELS } from "./outcome-plan-builder";

/**
 * StudioTune plan card — the shared visual surface the Home composer and the
 * Tune Agent rail both render. Every string it shows was produced by
 * `buildOutcomePlan`; nothing here fetches from a network, the Hub, or the
 * Engine.
 *
 * Interaction contract:
 *
 *   * `onAccept(step)` writes the plan's recipe locally through the
 *     Accept path in `applyPlanRecipe`. It never touches the Engine.
 *   * `onEdit(step)` opens the step's editor (a follow-up hop wires each
 *     step's editor; here it just fires the callback so the composer can
 *     scroll to the missing fact).
 *   * `onSkip(step)` marks the step skipped for this plan revision. Only
 *     optional steps (compare / export in this hop) may be Skipped —
 *     mandatory local-loop steps stay locked until their clarification is
 *     resolved.
 *   * `onReject(step)` clears any accepted proposal binding on that step.
 *     It never touches persisted state, never calls Engine, and is opt-in:
 *     if the composer doesn't pass an `onReject` handler, the Reject
 *     button is hidden. AIN-952 / APP-010.
 */
export type PlanCardHandlers = {
  onAccept?: (step: OutcomePlanStep) => void;
  onEdit?: (step: OutcomePlanStep) => void;
  onSkip?: (step: OutcomePlanStep) => void;
  /**
   * Clear this step's accepted proposal binding. Only rendered when the
   * caller wires a handler; the built-in Discard path handles whole-plan
   * rejection, so the step-level Reject stays optional.
   */
  onReject?: (step: OutcomePlanStep) => void;
  onResolveClarification?: (id: OutcomePlanClarificationId) => void;
  /** Discard the whole plan. Never calls Engine. */
  onDiscard?: () => void;
  /** Branch a second local plan without running either. */
  onBranch?: () => void;
  /** Rebuild the proposal from a revised prompt. */
  onRevise?: () => void;
};

const STATUS_COLOR: Record<OutcomePlanStep["status"], string> = {
  ready: "var(--ship-fg)",
  clarification: "var(--hold-fg)",
  optional: "var(--evidence-fg)",
};

const STATUS_LABEL: Record<OutcomePlanStep["status"], string> = {
  ready: "READY",
  clarification: "HOLD",
  optional: "OPTIONAL",
};

export function PlanCard({
  card,
  handlers,
}: {
  card: OutcomePlanCard;
  handlers?: PlanCardHandlers;
}) {
  return (
    <section
      className="studiotune-brand rounded-lg border border-white/10 p-4"
      data-studiotune-surface="true"
      data-testid="home-plan-card"
      style={{
        background: "var(--ai-surface)",
        color: "var(--ai-text)",
      }}
    >
      <PlanCardHeader card={card} />
      <PlanCardClarifications
        clarifications={card.clarifications}
        onResolve={handlers?.onResolveClarification}
      />
      <ol
        className="mt-4 flex flex-col gap-2"
        data-testid="home-plan-steps"
        aria-label="Outcome plan steps"
      >
        {card.steps.map((step) => (
          <PlanCardStepRow key={step.id} step={step} handlers={handlers} />
        ))}
      </ol>
      <PlanCardRevisionBar handlers={handlers} />
    </section>
  );
}

function PlanCardRevisionBar({ handlers }: { handlers?: PlanCardHandlers }) {
  if (!handlers?.onDiscard && !handlers?.onBranch && !handlers?.onRevise) {
    return null;
  }
  return (
    <div
      className="mt-4 flex flex-wrap gap-2 border-t border-white/10 pt-3"
      data-testid="home-plan-revision-bar"
      aria-label="Revise, branch, or discard this plan"
    >
      {handlers.onRevise ? (
        <StepButton
          label="Revise"
          disabled={false}
          onClick={handlers.onRevise}
          testid="home-plan-revise"
          statusColor="var(--revise-fg)"
          hint="Rebuild this proposal from an edited prompt. Never calls Engine."
        />
      ) : null}
      {handlers.onBranch ? (
        <StepButton
          label="Branch"
          disabled={false}
          onClick={handlers.onBranch}
          testid="home-plan-branch"
          statusColor="var(--evidence-fg)"
          hint="Fork a second local plan. Neither plan runs."
        />
      ) : null}
      {handlers.onDiscard ? (
        <StepButton
          label="Discard"
          disabled={false}
          onClick={handlers.onDiscard}
          testid="home-plan-discard"
          statusColor="var(--reject-fg)"
          hint="Discard this plan. Nothing was trained."
        />
      ) : null}
    </div>
  );
}

function PlanCardHeader({ card }: { card: OutcomePlanCard }) {
  return (
    <header className="flex flex-col gap-2">
      <p
        className="text-sm font-semibold"
        data-testid="home-plan-summary"
        style={{ color: "var(--ai-text)" }}
      >
        {card.summary}
      </p>
      {card.diagnosis !== null ? (
        <p
          data-testid="home-plan-diagnosis"
          className="rounded-md border border-white/10 px-2 py-1 text-[11px]"
          style={{
            color: "var(--hold-fg)",
            fontFamily: "var(--studiotune-font-mono)",
          }}
        >
          HOLD · {card.diagnosis.disposition} · {card.diagnosis.code}
          {card.diagnosis.nextSafeAction
            ? ` · ${card.diagnosis.nextSafeAction}`
            : ""}
          {" · authority=false · action_taken=false"}
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs md:grid-cols-4">
        <PlanCardField
          label="Method"
          value={card.method}
          testid="home-plan-method"
        />
        <PlanCardField
          label="Runtime"
          value={card.runtime}
          testid="home-plan-runtime"
        />
        <PlanCardField
          label="Dataset"
          value={card.dataset}
          testid="home-plan-dataset"
        />
        <PlanCardField label="Cost" value={card.cost} testid="home-plan-cost" />
      </dl>
    </header>
  );
}

function PlanCardField({
  label,
  value,
  testid,
}: {
  label: string;
  value: string;
  testid: string;
}) {
  return (
    <div className="flex flex-col">
      <dt style={{ color: "var(--ai-faint)" }}>{label}</dt>
      <dd
        data-testid={testid}
        style={{
          color: "var(--ai-text)",
          fontFamily: "var(--studiotune-font-mono)",
        }}
      >
        {value}
      </dd>
    </div>
  );
}

function PlanCardClarifications({
  clarifications,
  onResolve,
}: {
  clarifications: readonly OutcomePlanClarificationId[];
  onResolve?: (id: OutcomePlanClarificationId) => void;
}) {
  if (clarifications.length === 0) {
    return null;
  }
  return (
    <ul
      className="mt-3 flex flex-wrap gap-2"
      data-testid="home-plan-clarifications"
      aria-label="Clarification chips"
    >
      {clarifications.map((id) => (
        <li key={id}>
          <button
            type="button"
            onClick={() => onResolve?.(id)}
            className="rounded-full border px-3 py-1 text-[11px] font-medium"
            data-testid={`home-plan-clarification-${id}`}
            style={{
              borderColor: "var(--hold-fg)",
              color: "var(--hold-fg)",
              background: "transparent",
            }}
          >
            {OUTCOME_PLAN_CLARIFICATION_LABELS[id]}
          </button>
        </li>
      ))}
    </ul>
  );
}

function PlanCardStepRow({
  step,
  handlers,
}: {
  step: OutcomePlanStep;
  handlers?: PlanCardHandlers;
}) {
  const color = STATUS_COLOR[step.status];
  const acceptDisabled = step.status === "clarification";
  const skipDisabled = step.status !== "optional";
  return (
    <li
      className="flex flex-col gap-1 rounded-md border border-white/10 p-3 md:flex-row md:items-center md:justify-between"
      data-testid={`home-plan-step-${step.id}`}
      data-plan-step-status={step.status}
    >
      <div className="flex flex-col">
        <div className="flex items-center gap-2 text-xs">
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide"
            style={{
              color,
              borderColor: color,
              border: "1px solid",
              background: "transparent",
            }}
          >
            {STATUS_LABEL[step.status]}
          </span>
          <span className="font-medium" style={{ color: "var(--ai-text)" }}>
            {step.label}
          </span>
        </div>
        <p className="mt-1 text-[11px]" style={{ color: "var(--ai-muted)" }}>
          {step.description}
        </p>
      </div>
      <div
        className="mt-2 flex gap-1 md:mt-0"
        aria-label={`${step.label} actions`}
      >
        <StepButton
          label="Accept"
          disabled={acceptDisabled}
          onClick={() => handlers?.onAccept?.(step)}
          testid={`home-plan-step-${step.id}-accept`}
          statusColor="var(--ship-fg)"
          hint={
            acceptDisabled
              ? "Resolve the clarification to Accept this step."
              : "Accept applies the recipe locally. Never calls Engine."
          }
        />
        <StepButton
          label="Edit"
          disabled={false}
          onClick={() => handlers?.onEdit?.(step)}
          testid={`home-plan-step-${step.id}-edit`}
          statusColor="var(--evidence-fg)"
          hint="Edit this step's parameters before Accept."
        />
        <StepButton
          label="Skip"
          disabled={skipDisabled}
          onClick={() => handlers?.onSkip?.(step)}
          testid={`home-plan-step-${step.id}-skip`}
          statusColor="var(--hold-fg)"
          hint={
            skipDisabled
              ? "This step is part of the local loop and cannot be Skipped."
              : "Skip this step for the current plan revision."
          }
        />
        {handlers?.onReject ? (
          <StepButton
            label="Reject"
            disabled={false}
            onClick={() => handlers.onReject?.(step)}
            testid={`home-plan-step-${step.id}-reject`}
            statusColor="var(--reject-fg)"
            hint="Reject this step's proposal. Nothing persists, nothing trains."
          />
        ) : null}
      </div>
    </li>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  testid,
  statusColor,
  hint,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  testid: string;
  statusColor: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      aria-label={`${label} — ${hint}`}
      data-testid={testid}
      className="rounded-md border px-2 py-1 text-[11px] font-medium transition-colors"
      style={{
        borderColor: disabled ? "rgba(255,255,255,0.1)" : statusColor,
        color: disabled ? "var(--ai-faint)" : statusColor,
        background: "transparent",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {label}
    </button>
  );
}
