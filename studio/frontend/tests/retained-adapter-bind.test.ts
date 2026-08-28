// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

// APP-007 / AIN-938: bind the retained CLI-007 adapter. Inspect only —
// no Engine, no train, no export, no Hub fetch. Quality stays unclaimed.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  CLI007_RETAINED,
  RetainedAdapterBindRefused,
  bindRetainedAdapter,
} from "../src/features/compare/retained-adapter-bind.ts";

const bindUrl = new URL(
  "../src/features/compare/retained-adapter-bind.ts",
  import.meta.url,
);
const pageUrl = new URL(
  "../src/features/compare/compare-page.tsx",
  import.meta.url,
);

const LOCAL = {
  adapterDir: "/tmp/studiotune-cli-007/adapter",
  parentSnapshotDir:
    "/Users/hizrianraz/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
  adapterSha256:
    "4842bc09742a8bc72db1388d375fe025179697ded5deba8ddaccfc5a5b9ea8b3",
};

test("bind: retained local adapter records hashes and never claims quality", () => {
  const bind = bindRetainedAdapter(LOCAL);
  assert.equal(bind.kind, "retained_adapter");
  assert.equal(bind.adapterSha256, LOCAL.adapterSha256);
  assert.equal(bind.parentSnapshot, LOCAL.parentSnapshotDir);
  assert.equal(bind.adapterDir, LOCAL.adapterDir);
  assert.equal(bind.authority, false);
  assert.equal(bind.qualityClaimed, false);
  assert.equal(bind.trainedThisHop, false);
  assert.ok(bind.adapterSha256.startsWith("4842bc09"));
});

test("bind: CLI007_RETAINED constants match the live inspect", () => {
  const bind = bindRetainedAdapter({
    adapterDir: CLI007_RETAINED.adapterDir,
    parentSnapshotDir: CLI007_RETAINED.parentSnapshotDir,
    adapterSha256: CLI007_RETAINED.adapterSha256,
  });
  assert.equal(bind.kind, "retained_adapter");
  assert.equal(bind.qualityClaimed, false);
  assert.equal(bind.authority, false);
  assert.equal(bind.trainedThisHop, false);
  assert.equal(
    CLI007_RETAINED.adapterSha256,
    "4842bc09742a8bc72db1388d375fe025179697ded5deba8ddaccfc5a5b9ea8b3",
  );
});

test("bind: refuses Hub / remote adapter or parent paths", () => {
  const remote = [
    "https://huggingface.co/mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    "hf://mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    "hub://owner/model",
  ];
  for (const path of remote) {
    assert.throws(
      () =>
        bindRetainedAdapter({
          ...LOCAL,
          adapterDir: path,
        }),
      RetainedAdapterBindRefused,
      `adapterDir refused: ${path}`,
    );
    assert.throws(
      () =>
        bindRetainedAdapter({
          ...LOCAL,
          parentSnapshotDir: path,
        }),
      RetainedAdapterBindRefused,
      `parentSnapshotDir refused: ${path}`,
    );
  }
});

test("bind: refuses a missing or invented adapter sha", () => {
  assert.throws(
    () =>
      bindRetainedAdapter({
        ...LOCAL,
        adapterSha256: "",
      }),
    RetainedAdapterBindRefused,
  );
  assert.throws(
    () =>
      bindRetainedAdapter({
        ...LOCAL,
        adapterSha256: "not-a-sha",
      }),
    RetainedAdapterBindRefused,
  );
});

test("bind source has no engine / train / approve / export / fetch", async () => {
  const src = await readFile(bindUrl, "utf8");
  assert.ok(!/from ["'][^"']*engine[^"']*["']/i.test(src));
  assert.ok(!/approve\s*\(/.test(src), "must not call approve()");
  assert.ok(!/export\s*\(/.test(src), "must not call export()");
  assert.ok(src.includes("trainedThisHop: false"));
  assert.ok(!/\bfetch\s*\(/.test(src));
  assert.ok(!/fake_qlora/i.test(src));
  assert.ok(!/mlx_lm\.lora/.test(src));
  assert.ok(src.includes("qualityClaimed: false"));
  assert.ok(src.includes("authority: false"));
  assert.ok(src.includes("trainedThisHop: false"));
});

test("compare page binds the retained adapter on the same HOLD surface", async () => {
  const src = await readFile(pageUrl, "utf8");
  assert.ok(src.includes("bindRetainedAdapter"));
  assert.ok(src.includes("CLI007_RETAINED"));
  assert.ok(src.includes("retained adapter bound, quality HOLD"));
  assert.ok(src.includes('data-studiotune-status="hold"'));
  assert.ok(src.includes("No candidate to compare yet"));
  assert.ok(!/path:\s*["']\/compare-/.test(src));
});
