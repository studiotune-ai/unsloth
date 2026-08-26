// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

import type {
  OutcomePlan,
  TuneAgentBridge,
  TuneAgentBridgeState,
  TuneAgentMode,
} from "./tune-agent-types";

/**
 * Tune Agent IPC — thin, fail-closed stub.
 *
 * Tune Agent lives in a separate repo (studiotune-ai/tune-agent) and runs as
 * its own process. This file is the desktop host's client half:
 *
 *  - When Tune Agent is not reachable (agent process missing, Tauri not
 *    present because we're in a browser preview, or the IPC handshake
 *    hasn't landed yet in this hop) the bridge returns a disconnected
 *    snapshot. The rail is expected to render its honest HOLD/empty state,
 *    never a fake plan.
 *  - When Tune Agent is reachable, this file will forward mode changes and
 *    plan requests via the Tauri `project_outcome_plan` invoke (added on
 *    the Rust side). That invoke is intentionally NOT wired in this hop —
 *    the rail proves it works in the disconnected case first.
 */

/** Neutral starting snapshot when we know nothing about Tune Agent. */
export function makeDisconnectedTuneAgentBridge(): TuneAgentBridge {
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
    async requestPlan(_request: string): Promise<OutcomePlan | null> {
      // Fail-closed: no live Tune Agent to answer, so we hand back null.
      // The rail keeps its HOLD state so we never fake a live plan.
      return null;
    },
  };
}

/**
 * Attempt to construct a live bridge to Tune Agent. Returns the disconnected
 * bridge when Tune Agent is not present, so callers always get a safe
 * bridge back and can render.
 *
 * The Tauri `invoke` import is intentionally lazy: this file is imported by
 * tests that run under Node with no `@tauri-apps/api` at all, and by the
 * browser preview which has no Tauri IPC.
 */
export async function loadTuneAgentBridge(): Promise<TuneAgentBridge> {
  // The web preview and the Node tests have no Tauri IPC. Bail early instead
  // of importing the plugin, which would fail-open on some hosts.
  if (typeof window === "undefined") {
    return makeDisconnectedTuneAgentBridge();
  }
  const win = window as unknown as { __TAURI__?: unknown };
  if (win.__TAURI__ === undefined) {
    return makeDisconnectedTuneAgentBridge();
  }

  // Tune Agent process handshake will land here in a follow-up hop. Until
  // then we still hand back the disconnected bridge so the rail renders an
  // honest disconnected state.
  return makeDisconnectedTuneAgentBridge();
}
