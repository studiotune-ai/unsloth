// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

import { useLayoutEffect, useMemo } from "react";

import { evaluateCompareQuality } from "./compare-quality";
import {
  CLI007_RETAINED,
  bindRetainedAdapter,
} from "./retained-adapter-bind";

/**
 * StudioTune Compare — parent vs candidate.
 *
 * HOLD placeholder for this hop: no fixtures are wired yet, so the page shows
 * an honest disconnected/empty state instead of a fake table. When fixtures
 * land it should label them as reference, not quality, and never Hub-fetch
 * models to score them.
 *
 * APP-007: a retained CLI-007 adapter may be bound for inspect. Identity
 * inference (parent vs parent+adapter, boring ping prompt) may exist as a
 * log; that is not a quality score. quality stays HOLD / claimed=false.
 */
export function ComparePage() {
  useLayoutEffect(() => {
    window.dispatchEvent(new Event("unsloth:app-shell-ready"));
  }, []);

  const quality = useMemo(
    () =>
      evaluateCompareQuality({
        parentPath: null,
        candidatePath: null,
        log: null,
      }),
    [],
  );

  const retained = useMemo(
    () =>
      bindRetainedAdapter({
        adapterDir: CLI007_RETAINED.adapterDir,
        parentSnapshotDir: CLI007_RETAINED.parentSnapshotDir,
        adapterSha256: CLI007_RETAINED.adapterSha256,
      }),
    [],
  );

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
          <p
            className="mt-4 text-xs"
            style={{ color: "var(--ai-muted)" }}
            data-studiotune-quality-claimed="false"
            data-studiotune-authority="false"
          >
            quality_claimed=false · status={quality.status} · {quality.reason}
          </p>
          <p
            className="mt-2 text-xs"
            style={{ color: "var(--ai-muted)" }}
            data-studiotune-retained-adapter="true"
            data-studiotune-retained-kind={retained.kind}
          >
            retained adapter bound, quality HOLD
          </p>
          <p className="mt-1 font-mono text-[11px]" style={{ color: "var(--ai-muted)" }}>
            sha256 {retained.adapterSha256.slice(0, 8)}… · parent snapshot on disk
          </p>
        </div>
      </section>
    </div>
  );
}
