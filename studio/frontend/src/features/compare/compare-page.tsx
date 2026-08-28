// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

import { useLayoutEffect, useMemo } from "react";

import { evaluateCompareQuality } from "./compare-quality";
import { IDENTITY_LOG, textsIdentical } from "./identity-log";
import {
  CLI007_RETAINED,
  bindRetainedAdapter,
} from "./retained-adapter-bind";

/**
 * StudioTune Compare — parent vs candidate.
 *
 * APP-007: identity log is mounted on this same /compare route. HOLD stays.
 * The pair is parent vs parent+adapter on a boring ping prompt. Identical
 * texts are not a quality score. Never Hub-fetch models to score them.
 */
export function ComparePage() {
  useLayoutEffect(() => {
    window.dispatchEvent(new Event("unsloth:app-shell-ready"));
  }, []);

  const quality = useMemo(
    () =>
      evaluateCompareQuality({
        parentPath: CLI007_RETAINED.parentSnapshotDir,
        candidatePath: CLI007_RETAINED.adapterDir,
        log: IDENTITY_LOG,
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

  const identical = textsIdentical(IDENTITY_LOG);

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
          className="w-full max-w-xl rounded-xl border border-white/10 p-6"
          data-studiotune-panel="true"
          data-studiotune-status="hold"
          data-testid="compare-identity-log"
          data-studiotune-identity="true"
          style={{ background: "var(--ai-panel)" }}
        >
          <div
            className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs font-medium"
            style={{ color: "var(--hold-fg)" }}
          >
            <span aria-hidden="true">●</span>
            HOLD
          </div>
          <h2
            className="text-base font-semibold"
            style={{ color: "var(--ai-text)" }}
          >
            Identity log
          </h2>
          <p className="mt-2 text-sm" style={{ color: "var(--ai-muted)" }}>
            Parent vs parent+adapter on a boring ping prompt. Identical texts;
            identity inference is not quality.
          </p>
          <dl className="mt-4 space-y-3 text-left">
            <div>
              <dt
                className="text-xs uppercase tracking-wide"
                style={{ color: "var(--ai-muted)" }}
              >
                prompt
              </dt>
              <dd
                className="mt-1 font-mono text-xs whitespace-pre-wrap"
                style={{ color: "var(--ai-text)" }}
              >
                {IDENTITY_LOG.prompt}
              </dd>
            </div>
            <div>
              <dt
                className="text-xs uppercase tracking-wide"
                style={{ color: "var(--ai-muted)" }}
              >
                parent_text
              </dt>
              <dd
                className="mt-1 font-mono text-xs whitespace-pre-wrap"
                style={{ color: "var(--ai-text)" }}
              >
                {IDENTITY_LOG.parent_text}
              </dd>
            </div>
            <div>
              <dt
                className="text-xs uppercase tracking-wide"
                style={{ color: "var(--ai-muted)" }}
              >
                candidate_text
              </dt>
              <dd
                className="mt-1 font-mono text-xs whitespace-pre-wrap"
                style={{ color: "var(--ai-text)" }}
              >
                {IDENTITY_LOG.candidate_text}
              </dd>
            </div>
          </dl>
          <p
            className="mt-4 text-xs"
            style={{ color: "var(--ai-muted)" }}
          >
            identical={identical ? "true" : "false"} · quality_claimed=false
          </p>
          <p
            className="mt-2 text-xs"
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
