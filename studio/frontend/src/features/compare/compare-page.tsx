// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

import { useLayoutEffect } from "react";

/**
 * StudioTune Compare — parent vs candidate.
 *
 * HOLD placeholder for this hop: no fixtures are wired yet, so the page shows
 * an honest disconnected/empty state instead of a fake table. When fixtures
 * land it should label them as reference, not quality, and never Hub-fetch
 * models to score them.
 */
export function ComparePage() {
  useLayoutEffect(() => {
    window.dispatchEvent(new Event("unsloth:app-shell-ready"));
  }, []);

  return (
    <div
      className="studiotune-brand flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-studiotune-surface="true"
      data-studiotune-page="compare"
    >
      <header className="border-b border-white/5 px-6 pt-8 pb-4">
        <h1 className="studiotune-wordmark text-2xl font-semibold">Compare</h1>
        <p
          className="mt-1 max-w-xl text-sm"
          style={{ color: "var(--ai-muted)" }}
        >
          Parent vs candidate for a StudioTune training run. Loads locally from
          checkpoints on this machine; never Hub-fetches models to score them.
        </p>
      </header>

      <section className="flex flex-1 min-h-0 items-center justify-center p-6">
        <div
          className="max-w-md rounded-xl border border-white/10 p-6 text-center"
          data-studiotune-panel="true"
          data-studiotune-status="hold"
          style={{ background: "var(--ai-panel)" }}
        >
          <div
            className="mx-auto mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs font-medium"
            style={{ color: "var(--hold-fg)" }}
          >
            <span aria-hidden="true">●</span>
            HOLD
          </div>
          <h2
            className="text-base font-semibold"
            style={{ color: "var(--ai-text)" }}
          >
            No candidate to compare yet
          </h2>
          <p className="mt-2 text-sm" style={{ color: "var(--ai-muted)" }}>
            Compare surfaces once a StudioTune training run produces a candidate
            checkpoint on this machine. This hop ships the rail and the empty
            state; the reference-vs-candidate table lands next.
          </p>
        </div>
      </section>
    </div>
  );
}
