// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * Tauri config brand contract. Locks the StudioTune identity in
 * src-tauri/tauri.conf.json so a config-edit tool cannot re-brand the
 * desktop back to Unsloth in a driveby.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CONF_PATH = new URL("../../src-tauri/tauri.conf.json", import.meta.url);
const raw = readFileSync(CONF_PATH, "utf8");
const conf = JSON.parse(raw) as {
  productName: string;
  identifier: string;
  app: { windows: Array<{ title: string; titleBarStyle: string }> };
  plugins: {
    "deep-link"?: { desktop?: { schemes?: string[] } };
    updater?: { endpoints?: string[] };
  };
  bundle: {
    publisher: string;
    copyright: string;
    homepage?: string;
    createUpdaterArtifacts?: boolean;
  };
};

test("productName is StudioTune", () => {
  assert.equal(conf.productName, "StudioTune");
});

test("bundle identifier is ai.studiotune.desktop", () => {
  assert.equal(conf.identifier, "ai.studiotune.desktop");
});

test("main window title is StudioTune and titleBarStyle is Overlay", () => {
  const win = conf.app.windows.find((w) => w.title !== undefined);
  assert.ok(win, "expected a main window entry");
  assert.equal(win?.title, "StudioTune");
  assert.equal(win?.titleBarStyle, "Overlay");
});

test("publisher is Ainfera Inc", () => {
  assert.equal(conf.bundle.publisher, "Ainfera Inc");
});

test("homepage points at studiotune.ai (or is unset)", () => {
  const homepage = conf.bundle.homepage;
  if (homepage !== undefined) {
    assert.match(
      homepage,
      /studiotune\.ai/,
      "homepage must not point at unsloth.ai",
    );
  }
});

test("deep-link primary scheme is studiotune", () => {
  const schemes = conf.plugins["deep-link"]?.desktop?.schemes ?? [];
  assert.equal(schemes[0], "studiotune", "studiotune must lead the schemes");
});

test("Unsloth GitHub updater endpoints are gone", () => {
  const endpoints = conf.plugins.updater?.endpoints ?? [];
  for (const endpoint of endpoints) {
    assert.doesNotMatch(
      endpoint,
      /unslothai\/unsloth/,
      `updater endpoint must not hit unslothai/unsloth releases (got ${endpoint})`,
    );
  }
});

test("Unsloth copyright is not silently kept on the bundle", () => {
  assert.doesNotMatch(
    conf.bundle.copyright,
    /^© \d{4} Unsloth AI\.[^A-Za-z]*All rights reserved\.$/,
    "the bundle copyright must acknowledge Ainfera Inc; Unsloth attribution belongs in attribution/STUDIOTUNE.md",
  );
});
