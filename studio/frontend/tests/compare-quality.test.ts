// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

// APP-007 / AIN-938: freeze /compare quality as HOLD. Fixtures are not
// quality. Hub paths are refused. Even a real local parent+candidate log
// cannot claim quality on this hop.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  CompareQualityRefused,
  evaluateCompareQuality,
  isRemoteComparePath,
} from "../src/features/compare/compare-quality.ts";

const pageUrl = new URL(
  "../src/features/compare/compare-page.tsx",
  import.meta.url,
);
const qualityUrl = new URL(
  "../src/features/compare/compare-quality.ts",
  import.meta.url,
);

test("empty / missing parent or candidate stays HOLD, claimed false", () => {
  const cases = [
    {},
    { parentPath: null, candidatePath: null, log: null },
    { parentPath: "", candidatePath: "", log: "" },
    { parentPath: "   ", candidatePath: "   " },
    { parentPath: "/tmp/studiotune-cli-007/adapter", candidatePath: null },
    { parentPath: null, candidatePath: "/tmp/studiotune-cli-007/adapter" },
  ];
  for (const input of cases) {
    const result = evaluateCompareQuality(input);
    assert.equal(result.claimed, false);
    assert.equal(result.status, "HOLD");
    assert.equal(result.authority, false);
    assert.equal(result.reason, "missing parent or candidate");
  }
});

test("fixture log cannot claim quality", () => {
  const local = {
    parentPath:
      "/Users/hizrianraz/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
    candidatePath: "/tmp/studiotune-cli-007/adapter",
  };
  const fixtures = [
    { fixture: true },
    { kind: "fixture" },
    { source: "fixture" },
    { label: "fixture-run" },
    { labeled: "fixture" },
    "fixture compare log",
  ] as const;
  for (const log of fixtures) {
    const result = evaluateCompareQuality({ ...local, log });
    assert.equal(result.claimed, false, `claimed for ${JSON.stringify(log)}`);
    assert.equal(result.status, "HOLD");
    assert.equal(result.authority, false);
    assert.equal(result.reason, "fixture log cannot claim quality");
  }
});

test("Hub / remote parent or candidate is refused with a typed error", () => {
  const refused = [
    "https://huggingface.co/mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    "http://example.com/adapter",
    "hf://mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    "huggingface://mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    "hub://mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    "  https://hf.co/owner/model  ",
  ];
  for (const path of refused) {
    assert.equal(
      isRemoteComparePath(path.trim() === path ? path : path),
      true,
      `isRemoteComparePath(${JSON.stringify(path)})`,
    );
    assert.throws(
      () =>
        evaluateCompareQuality({
          parentPath: path,
          candidatePath: "/tmp/studiotune-cli-007/adapter",
          log: { kind: "live" },
        }),
      CompareQualityRefused,
      `parent refused: ${path}`,
    );
    assert.throws(
      () =>
        evaluateCompareQuality({
          parentPath:
            "/Users/hizrianraz/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
          candidatePath: path,
          log: { kind: "live" },
        }),
      CompareQualityRefused,
      `candidate refused: ${path}`,
    );
  }
});

test("real local parent+candidate non-fixture log still HOLD on this hop", () => {
  const result = evaluateCompareQuality({
    parentPath:
      "/Users/hizrianraz/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
    candidatePath: "/tmp/studiotune-cli-007/adapter",
    log: { kind: "live-inspect", source: "local" },
  });
  assert.equal(result.claimed, false);
  assert.equal(result.status, "HOLD");
  assert.equal(result.authority, false);
  assert.equal(result.reason, "no live parent/candidate inference yet");
});

test("page source stays HOLD empty state and does not contain a quality score", async () => {
  const src = await readFile(pageUrl, "utf8");
  assert.ok(src.includes('data-studiotune-status="hold"'));
  assert.ok(src.includes("No candidate to compare yet"));
  assert.ok(src.includes("quality_claimed=false"));
  assert.ok(src.includes("retained adapter bound, quality HOLD"));
  assert.ok(
    !/quality[_ ]?(score|pct|percent|metric)\s*[:=]/i.test(src),
    "must not render a quality score",
  );
  assert.ok(!/\bscore\s*[:=]\s*\d/i.test(src), "must not render score=N");
  assert.ok(
    !/\b(win_rate|bleu|rouge|accuracy|eval_loss)\b/i.test(src),
    "must not render a scoring metric",
  );
  assert.ok(!/fake_qlora/i.test(src), "must not claim FakeExecutor");
});

test("quality module has no engine / train / hub / fetch side effects", async () => {
  const src = await readFile(qualityUrl, "utf8");
  assert.ok(!/from ["'][^"']*engine[^"']*["']/i.test(src));
  assert.ok(!/\bmlx_lm\.lora\b/.test(src));
  assert.ok(!/\bfetch\s*\(/.test(src));
  assert.ok(!/fake_qlora/i.test(src));
  assert.ok(!/claimed:\s*true/.test(src));
});
