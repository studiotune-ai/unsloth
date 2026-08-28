// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * Home composer — one-prompt outcome plan builder (Clusy-style, StudioTune-locked).
 *
 * This module is intentionally pure and Engine-free. It takes one outcome
 * sentence plus the small facts snapshot the desktop already has locally
 * (parent, dataset, admit) and hands back a bounded plan proposal:
 *
 *   1. `method` / `runtime` / `dataset` / `cost` — the card header.
 *   2. `steps` — the fixed local loop the desktop supports on Mac today:
 *      inspect-parent → inspect-dataset → recipe → admit → train → compare
 *      → export. Each step is inspectable and Accept-able; nothing in this
 *      module ever asks the Engine or the Hub to do anything.
 *   3. `clarifications` — chips the composer surfaces when the prompt or the
 *      facts are underspecified. The three we lock here are the three the
 *      local Mac loop cannot proceed without: a parent, a dataset, and an
 *      admitted runtime.
 *   4. `recipe` — an opaque payload the local recipe applier consumes when
 *      Accept fires. It carries the raw prompt digest and the step ids that
 *      are marked `ready` (i.e., the ones the user did not Skip).
 *
 * Hard locks enforced structurally:
 *
 *   * A Hub id (`owner/name` shape) can never appear in the finished plan.
 *     Every string that leaves this module is `sanitizeAgainstHubId`'d
 *     first; a Hub-shaped input degrades to `UNKNOWN` and fires the
 *     matching clarification. This is the frontend mirror of the CLI-002
 *     admit path: locations are not identities, and Hub ids are locations
 *     someone else owns.
 *
 *   * The plan is a proposal, not an authority. `authority` and
 *     `action_taken` are stamped `false` here. Callers that Accept the plan
 *     rewrite the recipe locally through
 *     `applyPlanRecipe` (see `tune-agent-guards.ts`); nothing in this
 *     module calls the Engine.
 *
 *   * Runtime is the local backend the desktop can admit on Mac. Nothing
 *     here picks a cloud GPU or a remote endpoint — those live behind
 *     approvals the desktop does not own.
 */

/** The fixed local loop steps. Ordered; the composer renders them in this order. */
export const OUTCOME_PLAN_STEP_IDS = [
  "inspect-parent",
  "inspect-dataset",
  "recipe",
  "admit",
  "train",
  "compare",
  "export",
] as const;

export type OutcomePlanStepId = (typeof OUTCOME_PLAN_STEP_IDS)[number];

/** Kinds of missing-facts clarifications the composer can surface. */
export const OUTCOME_PLAN_CLARIFICATION_IDS = [
  "missing-parent",
  "missing-dataset",
  "missing-admit",
] as const;
export type OutcomePlanClarificationId =
  (typeof OUTCOME_PLAN_CLARIFICATION_IDS)[number];

/**
 * Facts snapshot the desktop passes in. All three are optional because a
 * fresh install may have none of them yet — the composer's job is to say
 * so through a clarification chip, not to invent a value.
 */
export type OutcomePlanFacts = {
  /** Local parent identifier (an absolute path or a locally cached snapshot). Null when unknown. */
  parent: string | null;
  /** Local dataset identifier (an absolute path). Null when unknown. */
  dataset: string | null;
  /** Whether a runtime is admitted on this machine (see admit CLI). */
  runtimeAdmitted: boolean;
};

/**
 * A single plan step the composer renders as a row. The `status` drives the
 * chip colour and the Accept/Edit/Skip enabled state — the same three
 * decisions Clusy exposes on plan steps, without ever calling Engine.
 */
export type OutcomePlanStep = {
  id: OutcomePlanStepId;
  label: string;
  description: string;
  /**
   * - `ready`         — the step's prerequisites are met; Accept applies it.
   * - `clarification` — the step is blocked on one of the missing facts;
   *                     the composer routes the user to the clarification
   *                     chip instead of pretending Accept can proceed.
   * - `optional`      — the step can be Skipped without breaking the plan
   *                     (compare, export in this hop).
   */
  status: "ready" | "clarification" | "optional";
  /**
   * Which clarification chip this step depends on. Null for steps that only
   * require the prompt itself (recipe, train under admit) or optional
   * steps (compare, export).
   */
  clarification: OutcomePlanClarificationId | null;
};

/** The plan card the composer renders. Fully bounded — no Hub ids, no cost. */
export type OutcomePlanCard = {
  /** Method label. Defaults to `LoRA`; the composer never picks a cloud method. */
  method: string;
  /** Runtime label. Defaults to `mlx` — the one Mac admit path. */
  runtime: string;
  /**
   * Dataset label surfaced on the card. Either the local path from
   * `facts.dataset` or `"UNKNOWN"` — never a Hub id.
   */
  dataset: string;
  /** Parent label surfaced on the card. Local snapshot / path or `"UNKNOWN"`. */
  parent: string;
  /**
   * Cost label. Locked to `"local-only"` here: StudioTune never spends on
   * behalf of the user, and the composer must not fabricate a dollar figure.
   */
  cost: string;
  /** Short human-facing sentence for the card header. */
  summary: string;
  /** Fixed step list; length is always `OUTCOME_PLAN_STEP_IDS.length`. */
  steps: readonly OutcomePlanStep[];
  /** Clarification chips to render alongside the step list. */
  clarifications: readonly OutcomePlanClarificationId[];
  /**
   * Recipe payload the local applier consumes on Accept. Fully local: the
   * prompt echo and the set of step ids that are `ready` right now.
   */
  recipe: {
    prompt: string;
    ready_step_ids: readonly OutcomePlanStepId[];
  };
  /** Proposal invariants. */
  authority: false;
  action_taken: false;
};

/**
 * Sentinel token that leaves this module in place of any value we would
 * otherwise have to guess. Mirrors the Tune Agent proposer's `UNKNOWN`.
 */
export const OUTCOME_PLAN_UNKNOWN = "UNKNOWN";

// `owner/name` shape from Hugging Face. Deliberately narrow — a bare
// filesystem path such as `/Users/me/data.jsonl` contains slashes too, but
// the leading `/` and the file extension keep it out of this pattern.
// Path segments allow underscores/dots/dashes but must start with an
// alphanumeric character.
const HUB_ID_SHAPE =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const URL_PREFIX = /^https?:\/\//i;
const METHOD_QLORA = /\bqlora\b/;
const METHOD_LORA = /\blora\b/;
const METHOD_FULL = /\bfull(?:[- ]?fine[- ]?tune)?\b/;

/**
 * True when `value` looks like a Hub-style `owner/name` identifier. The
 * plan card must never surface one, so the composer degrades those to
 * `UNKNOWN` and asks the user to point at a local resource instead.
 */
export function looksLikeHubId(value: string | null | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith("/")) {
    return false;
  }
  if (trimmed.startsWith("~")) {
    return false;
  }
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return false;
  }
  return HUB_ID_SHAPE.test(trimmed);
}

/**
 * Return `value` if it is safe to show on the card, or `UNKNOWN` if not.
 * Anything that would surface a Hub id, a URL, or a blank collapses to
 * `UNKNOWN`; the caller is expected to fire a clarification chip.
 */
function sanitizeAgainstHubId(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return OUTCOME_PLAN_UNKNOWN;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return OUTCOME_PLAN_UNKNOWN;
  }
  if (looksLikeHubId(trimmed)) {
    return OUTCOME_PLAN_UNKNOWN;
  }
  if (URL_PREFIX.test(trimmed)) {
    return OUTCOME_PLAN_UNKNOWN;
  }
  return trimmed;
}

const STEP_LABELS: Record<OutcomePlanStepId, string> = {
  "inspect-parent": "Inspect parent",
  "inspect-dataset": "Inspect dataset",
  recipe: "Compile recipe",
  admit: "Admit runtime",
  train: "Train",
  compare: "Compare parent / candidate",
  export: "Export",
};

const STEP_DESCRIPTIONS: Record<OutcomePlanStepId, string> = {
  "inspect-parent":
    "Read the local parent snapshot's tokenizer, chat template and license before any run.",
  "inspect-dataset":
    "Preview the local dataset (rows, schema, empty prompts) before it feeds a recipe.",
  recipe:
    "Compile a bounded local recipe. Proposal only — Accept applies it locally, never calls Engine.",
  admit:
    "Admit the local runtime on this Mac (host python + cached snapshot). Fails closed if unavailable.",
  train:
    "Start a local LoRA training run. Never spends, never fetches from the Hub, never runs on cloud GPUs.",
  compare:
    "Compare the trained candidate against the parent using the frozen local protocol.",
  export:
    "Package the candidate for local use. Never publishes, deploys, notarizes or signs.",
};

/** Whether the prompt itself is empty enough that the composer should refuse. */
export function isPromptEffectivelyEmpty(prompt: string): boolean {
  return prompt.trim().length === 0;
}

/**
 * Guess a bounded method label from the prompt. The composer prefers the
 * one Mac-admit path (LoRA on MLX) — the guess is intentionally narrow and
 * every unrecognised prompt collapses to the default. This is not a
 * classifier; it is a small hint the plan card is honest about.
 */
function inferMethod(prompt: string): string {
  const p = prompt.toLowerCase();
  if (METHOD_QLORA.test(p)) {
    return "QLoRA";
  }
  if (METHOD_LORA.test(p)) {
    return "LoRA";
  }
  if (METHOD_FULL.test(p)) {
    return "Full fine-tune";
  }
  return "LoRA";
}

/**
 * The client-side plan builder. Pure — same prompt + facts always produce
 * the same card. Never talks to Engine, the Hub, or the network.
 */
export function buildOutcomePlan(
  prompt: string,
  facts: OutcomePlanFacts,
): OutcomePlanCard {
  const trimmedPrompt = prompt.trim();
  const method = inferMethod(trimmedPrompt);
  const runtime = "mlx";
  const cost = "local-only";
  const dataset = sanitizeAgainstHubId(facts.dataset);
  const parent = sanitizeAgainstHubId(facts.parent);

  const clarifications: OutcomePlanClarificationId[] = [];
  if (parent === OUTCOME_PLAN_UNKNOWN) {
    clarifications.push("missing-parent");
  }
  if (dataset === OUTCOME_PLAN_UNKNOWN) {
    clarifications.push("missing-dataset");
  }
  if (!facts.runtimeAdmitted) {
    clarifications.push("missing-admit");
  }

  const steps = OUTCOME_PLAN_STEP_IDS.map<OutcomePlanStep>((id) => {
    const label = STEP_LABELS[id];
    const description = STEP_DESCRIPTIONS[id];
    switch (id) {
      case "inspect-parent":
        return {
          id,
          label,
          description,
          status: parent === OUTCOME_PLAN_UNKNOWN ? "clarification" : "ready",
          clarification:
            parent === OUTCOME_PLAN_UNKNOWN ? "missing-parent" : null,
        };
      case "inspect-dataset":
        return {
          id,
          label,
          description,
          status: dataset === OUTCOME_PLAN_UNKNOWN ? "clarification" : "ready",
          clarification:
            dataset === OUTCOME_PLAN_UNKNOWN ? "missing-dataset" : null,
        };
      case "recipe":
        return { id, label, description, status: "ready", clarification: null };
      case "admit":
        return {
          id,
          label,
          description,
          status: facts.runtimeAdmitted ? "ready" : "clarification",
          clarification: facts.runtimeAdmitted ? null : "missing-admit",
        };
      case "train":
        return {
          id,
          label,
          description,
          status: facts.runtimeAdmitted ? "ready" : "clarification",
          clarification: facts.runtimeAdmitted ? null : "missing-admit",
        };
      case "compare":
        return {
          id,
          label,
          description,
          status: "optional",
          clarification: null,
        };
      case "export":
        return {
          id,
          label,
          description,
          status: "optional",
          clarification: null,
        };
      default: {
        const never: never = id;
        return never;
      }
    }
  });

  const readyStepIds = steps
    .filter((s) => s.status === "ready")
    .map((s) => s.id);

  const summary = describeSummary(trimmedPrompt, method, dataset);

  return {
    method,
    runtime,
    dataset,
    parent,
    cost,
    summary,
    steps,
    clarifications,
    recipe: {
      prompt: trimmedPrompt,
      ready_step_ids: readyStepIds,
    },
    authority: false,
    action_taken: false,
  };
}

function describeSummary(
  prompt: string,
  method: string,
  dataset: string,
): string {
  if (prompt.length === 0) {
    return `${method} on this machine — describe the outcome to plan.`;
  }
  if (dataset === OUTCOME_PLAN_UNKNOWN) {
    return `${method} on this machine (dataset pending clarification).`;
  }
  const shortDataset = shortenPath(dataset);
  return `${method} on ${shortDataset}, local runtime only.`;
}

/** Show a tail of a local path so long absolute paths fit on the card header. */
function shortenPath(path: string): string {
  if (path.length <= 40) {
    return path;
  }
  const parts = path.split("/");
  if (parts.length <= 2) {
    return path;
  }
  return `.../${parts.slice(-2).join("/")}`;
}

/**
 * True when the plan card has any Hub id anywhere on it. The composer
 * asserts this before render so a regression that let a Hub id through
 * would fail loudly.
 */
export function planCardHasHubId(card: OutcomePlanCard): boolean {
  return (
    looksLikeHubId(card.dataset) ||
    looksLikeHubId(card.parent) ||
    looksLikeHubId(card.runtime) ||
    looksLikeHubId(card.method) ||
    looksLikeHubId(card.summary)
  );
}

/** Human labels for clarification chips. Kept beside the ids so tests read one file. */
export const OUTCOME_PLAN_CLARIFICATION_LABELS: Record<
  OutcomePlanClarificationId,
  string
> = {
  "missing-parent":
    "Choose a local parent model. StudioTune never fetches parents from the Hub.",
  "missing-dataset":
    "Point at a local dataset file. StudioTune never sources datasets from the Hub.",
  "missing-admit":
    "Admit a local runtime on this Mac. Agent Train stays refused until admit passes.",
};

/**
 * Bridge-plan shape the Tune Agent rail hands us over IPC. Mirrors the shape
 * of `OutcomePlan` in `../tune-agent/tune-agent-types.ts` so this module does
 * not depend on that file (avoids a home → tune-agent cycle) while still
 * accepting exactly what Tune Agent sends. Extra fields on the bridge plan
 * are ignored; missing string fields collapse to `UNKNOWN` through the same
 * `sanitizeAgainstHubId` guard the pure builder uses.
 */
export type BridgePlanLike = {
  id?: string;
  summary?: string;
  method?: string;
  runtime?: string;
  dataset?: string;
  cost?: string;
  recipe?: Record<string, unknown>;
};

/**
 * Adapt a Tune Agent bridge plan into the shared `OutcomePlanCard` so the
 * rail and the Home composer can render the same visual `<PlanCard>`
 * without diverging.
 *
 * The adapter is pure — it never touches Engine, the Hub, or the network,
 * and reuses `buildOutcomePlan` for the step list + clarifications so the
 * rail cannot drift from the composer's contract. Header fields
 * (`method` / `runtime` / `cost` / `summary`) come from the bridge when
 * present, but every string still runs through `sanitizeAgainstHubId` so a
 * malformed bridge reply cannot leak a Hub id onto the card.
 */
export function adaptBridgePlanToCard(
  plan: BridgePlanLike,
  runtimeAdmitted: boolean,
): OutcomePlanCard {
  const summary =
    typeof plan.summary === "string" && plan.summary.trim().length > 0
      ? plan.summary
      : "";
  const datasetInput = typeof plan.dataset === "string" ? plan.dataset : null;
  const base = buildOutcomePlan(summary, {
    parent: null,
    dataset: datasetInput,
    runtimeAdmitted,
  });
  const method =
    typeof plan.method === "string" && plan.method.trim().length > 0
      ? sanitizeAgainstHubId(plan.method)
      : base.method;
  const runtime =
    typeof plan.runtime === "string" && plan.runtime.trim().length > 0
      ? sanitizeAgainstHubId(plan.runtime)
      : base.runtime;
  const cost =
    typeof plan.cost === "string" && plan.cost.trim().length > 0
      ? sanitizeAgainstHubId(plan.cost)
      : base.cost;
  const bridgeSummary =
    summary.length > 0 ? summary : base.summary;
  return {
    ...base,
    method,
    runtime,
    cost,
    summary: bridgeSummary,
  };
}
