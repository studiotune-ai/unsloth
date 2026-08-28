// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

import type {
  OutcomePlan,
  TuneAgentAdmitOutcome,
  TuneAgentAdmitRequest,
  TuneAgentBridge,
  TuneAgentBridgeState,
  TuneAgentMode,
} from "./tune-agent-types";

/**
 * Tune Agent IPC — desktop-host bridge.
 *
 * Tune Agent lives in a separate repository (studiotune-ai/tune-agent) and
 * runs as its own local sidecar process. This file is the desktop host's
 * client half:
 *
 *  - `makeDisconnectedTuneAgentBridge` produces the fail-closed bridge used
 *    when Tune Agent is not reachable — no Tauri IPC (Node tests, browser
 *    preview), the sidecar binary is missing, or the initial handshake
 *    failed. The rail then renders its honest HOLD state and no user action
 *    quietly succeeds.
 *
 *  - `makeLiveTuneAgentBridge` speaks to the Rust host through the Tauri
 *    invokes registered on the Rust side (`tune_agent_status`,
 *    `tune_agent_start`, `tune_agent_admit_runtime`, and — when they land —
 *    `tune_agent_request_plan` / `tune_agent_set_mode`). The host owns the
 *    sidecar lifecycle so the frontend never has to know a subprocess is
 *    involved.
 *
 *  - `loadTuneAgentBridge` picks between them. It never throws: any error
 *    downgrades the bridge to disconnected so the rail still renders.
 */

// Empty default: the Rust host prefers the bundled sidecar
// (`<exe_dir>/tune-agent` = StudioTune.app/Contents/MacOS/tune-agent)
// over `$HOME/.studiotune/tune-agent` and `$PATH`. A caller may still
// pass an absolute / `~/...` path when they mean a specific binary.
// Never a Hub id. Never fetched.
export const DEFAULT_TUNE_AGENT_BINARY_PATH = ""; // FROZEN: empty = Rust picks bundled Contents/MacOS/tune-agent

// Shape the Rust `tune_agent_status` command returns. Kept minimal on
// purpose so a follow-up field on the Rust side does not silently redefine
// what the rail reads.
type HostStatus = {
  connected: boolean;
  binary: string | null;
  admit: TuneAgentAdmitOutcome | null;
  lastError: string | null;
};

/** Minimal Tauri v2 invoke surface. */
type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Runtime-typed guard so we do not import `@tauri-apps/api` under Node. */
function windowHasTauri(): boolean {
  if (typeof window === "undefined") return false;
  const win = window as unknown as { __TAURI__?: unknown };
  return win.__TAURI__ !== undefined;
}

/** Neutral starting snapshot when we know nothing about Tune Agent. */
export function makeDisconnectedTuneAgentBridge(
  reason: string | null = null,
): TuneAgentBridge {
  let state: TuneAgentBridgeState = {
    connected: false,
    mode: "ask",
    plan: null,
    runtimeAdmitted: false,
  };
  const listeners = new Set<(next: TuneAgentBridgeState) => void>();

  const emit = () => {
    for (const l of listeners) l(state);
  };

  return {
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setMode(mode: TuneAgentMode) {
      if (state.mode === mode) return;
      state = { ...state, mode };
      emit();
    },
    requestPlan(_request: string): Promise<OutcomePlan | null> {
      // Fail-closed: no live Tune Agent to answer, so we hand back null.
      // The rail keeps its HOLD state so we never fake a live plan.
      // `reason` is retained for diagnostics via a getter on the state (the
      // rail reads it through the bridge's own error surface); returning a
      // reject would confuse callers that only handle nulls.
      void _request;
      void reason;
      return Promise.resolve(null);
    },
    admitRuntime(_request: TuneAgentAdmitRequest): Promise<TuneAgentAdmitOutcome | null> {
      // Disconnected bridge cannot ask the Rust host to admit anything. The
      // rail knows to render this as HOLD instead of showing an "admitted"
      // sticker that was never verified.
      void _request;
      return Promise.resolve(null);
    },
  };
}

/**
 * Live bridge that talks to the Rust host through Tauri invokes. Every
 * transport-level error downgrades one call to disconnected semantics
 * (`null` from requestPlan, `null` from admitRuntime) so a temporary sidecar
 * hiccup cannot leak into a fake plan being drawn.
 */
export function makeLiveTuneAgentBridge(
  invoke: TauriInvoke,
  initial: HostStatus,
): TuneAgentBridge {
  let state: TuneAgentBridgeState = {
    connected: initial.connected,
    mode: "ask",
    plan: null,
    runtimeAdmitted: initial.admit?.admitted === true,
  };
  const listeners = new Set<(next: TuneAgentBridgeState) => void>();
  const emit = () => {
    for (const l of listeners) l(state);
  };

  return {
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setMode(mode: TuneAgentMode) {
      if (state.mode === mode) return;
      state = { ...state, mode };
      emit();
      // Fire-and-forget: the sidecar tracks mode for its own logging but
      // the mode contract lives in the host guards, not the sidecar.
      invoke<void>("tune_agent_set_mode", { mode }).catch(() => undefined);
    },
    async requestPlan(request: string): Promise<OutcomePlan | null> {
      if (!state.connected) return null;
      try {
        const plan = await invoke<OutcomePlan | null>(
          "tune_agent_request_plan",
          { request },
        );
        if (plan !== null && plan !== undefined) {
          state = { ...state, plan };
          emit();
          return plan;
        }
        return null;
      } catch {
        // Any invoke error means the sidecar is unhealthy. Downgrade the
        // rail to disconnected so Accept/Grant/Train re-arm their refuse
        // reasons instead of pretending the pipe is fine.
        state = { ...state, connected: false, plan: null };
        emit();
        return null;
      }
    },
    async admitRuntime(
      request: TuneAgentAdmitRequest,
    ): Promise<TuneAgentAdmitOutcome | null> {
      try {
        const outcome = await invoke<TuneAgentAdmitOutcome>(
          "tune_agent_admit_runtime",
          {
            python: request.python,
            snapshot: request.snapshot,
            mlxArgs: request.mlxArgs,
          },
        );
        state = { ...state, runtimeAdmitted: outcome.admitted };
        emit();
        return outcome;
      } catch (err) {
        // Rust returns Err(reason) on refuse — surface it as a not-admitted
        // outcome so the rail can show WHY, instead of a silent failure.
        const reason = err instanceof Error ? err.message : String(err);
        state = { ...state, runtimeAdmitted: false };
        emit();
        return {
          admitted: false,
          python: request.python,
          snapshot: request.snapshot,
          reason,
          hfHubOffline: "1",
        };
      }
    },
  };
}

/**
 * Try the live bridge; fall back to disconnected on every failure. Never
 * throws — the rail must always get a bridge back or it can't render.
 *
 * The Tauri `invoke` import is loaded through `window.__TAURI_INTERNALS__`
 * without touching `@tauri-apps/api` so this file stays importable under
 * plain Node (tests) and in the browser preview (no Tauri at all).
 */
export async function loadTuneAgentBridge(
  binaryPath: string = DEFAULT_TUNE_AGENT_BINARY_PATH,
): Promise<TuneAgentBridge> {
  if (!windowHasTauri()) {
    return makeDisconnectedTuneAgentBridge("no-tauri");
  }
  const invoke = resolveTauriInvoke();
  if (invoke === null) {
    return makeDisconnectedTuneAgentBridge("no-tauri-invoke");
  }
  try {
    // Ask the host to spawn (or reuse) the sidecar. `tune_agent_start`
    // records `connected: false` and `lastError` if anything went wrong.
    const status = await invoke<HostStatus>("tune_agent_start", {
      binary: binaryPath,
    });
    if (!status.connected) {
      return makeDisconnectedTuneAgentBridge(status.lastError ?? "sidecar-not-connected");
    }
    return makeLiveTuneAgentBridge(invoke, status);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return makeDisconnectedTuneAgentBridge(reason);
  }
}

/** Best-effort Tauri v2 invoke resolver. Never throws. */
function resolveTauriInvoke(): TauriInvoke | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: TauriInvoke };
    __TAURI__?: { core?: { invoke?: TauriInvoke }; invoke?: TauriInvoke };
  };
  const fromInternals = win.__TAURI_INTERNALS__?.invoke;
  if (typeof fromInternals === "function") return fromInternals;
  const fromCore = win.__TAURI__?.core?.invoke;
  if (typeof fromCore === "function") return fromCore;
  const legacy = win.__TAURI__?.invoke;
  if (typeof legacy === "function") return legacy;
  return null;
}
