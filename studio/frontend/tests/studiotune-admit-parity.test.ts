// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * Rust <-> frontend admit-policy parity.
 *
 * The Tune Agent rail hardcodes the exact python and MLX snapshot the
 * StudioTune admit policy accepts. Rust `tune_agent::ADMITTED_HOST_PYTHON`
 * / `ADMITTED_MLX_SNAPSHOTS` are the source of truth. If someone changes
 * either side without the other, admit will refuse forever with a stale
 * mismatch message the user can't act on. Lock the two sides together here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const RUST_SOURCE = readFileSync(
  new URL("../../src-tauri/src/tune_agent.rs", import.meta.url),
  "utf8",
);
const RAIL_SOURCE = readFileSync(
  new URL("../src/features/tune-agent/tune-agent-rail.tsx", import.meta.url),
  "utf8",
);

function extractRustStringConst(name: string): string {
  const pattern = new RegExp(
    `${name}[^=]*=\\s*"([^"]+)"`,
  );
  const match = RUST_SOURCE.match(pattern);
  assert.ok(match, `could not find Rust constant ${name}`);
  return match?.[1] ?? "";
}

function extractFirstAllowedSnapshot(): string {
  // ADMITTED_MLX_SNAPSHOTS: &[&str] = &[ "…" ];
  const start = RUST_SOURCE.indexOf("ADMITTED_MLX_SNAPSHOTS");
  assert.ok(start > -1, "ADMITTED_MLX_SNAPSHOTS not found");
  const window = RUST_SOURCE.slice(start, start + 800);
  const match = window.match(/"([^"]+)"/);
  assert.ok(match, "no snapshot literal in ADMITTED_MLX_SNAPSHOTS");
  return match?.[1] ?? "";
}

test("Rust ADMITTED_HOST_PYTHON is the framework absolute path", () => {
  assert.equal(
    extractRustStringConst("ADMITTED_HOST_PYTHON"),
    "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13",
  );
});

test("Rust ADMITTED_MLX_SNAPSHOTS contains the Qwen2.5-0.5B-Instruct-4bit snapshot", () => {
  assert.equal(
    extractFirstAllowedSnapshot(),
    "~/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
  );
});

test("Rust admit policy declares HF_HUB_OFFLINE=1 for the sidecar env", () => {
  assert.equal(extractRustStringConst("HF_HUB_OFFLINE_KEY"), "HF_HUB_OFFLINE");
  assert.equal(extractRustStringConst("HF_HUB_OFFLINE_VALUE"), "1");
});

test("Tune Agent rail's Admit button quotes the same python and snapshot as Rust", () => {
  const python = extractRustStringConst("ADMITTED_HOST_PYTHON");
  const snapshot = extractFirstAllowedSnapshot();
  assert.ok(
    RAIL_SOURCE.includes(python),
    "the rail's Admit button must forward the Rust-admitted python path verbatim",
  );
  assert.ok(
    RAIL_SOURCE.includes(snapshot),
    "the rail's Admit button must forward the Rust-admitted snapshot path verbatim",
  );
});

test("Rust admit policy is a fixed allow-list, not a prefix match", () => {
  // Two things a follow-up refactor could accidentally do that would let
  // Hub ids or arbitrary paths through: (1) turn the array into a HashSet
  // that is edited from another module, (2) switch from equality to a
  // `starts_with` check. Both leave the string constants intact but drop
  // the safety we want. Lock the surrounding text so either change trips
  // this test.
  assert.match(
    RUST_SOURCE,
    /pub\(crate\) const ADMITTED_MLX_SNAPSHOTS: &\[&str\] = &\[/,
    "ADMITTED_MLX_SNAPSHOTS must stay a fixed &[&str] allow-list",
  );
  assert.match(
    RUST_SOURCE,
    /ADMITTED_MLX_SNAPSHOTS\.iter\(\)\.any\(\|allowed\| allowed == &snapshot\)/,
    "admit must use == against the allow-list, not starts_with",
  );
});
