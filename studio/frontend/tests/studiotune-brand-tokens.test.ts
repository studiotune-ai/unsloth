// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * StudioTune brand tokens are load-bearing: the Tune Agent rail, the plan
 * card, the wordmark, and the decision-status palette all read from them.
 * This test locks the token values so a well-meaning refactor cannot
 * quietly drift a shipped color or drop the wordmark font stack.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const BRAND_CSS_PATH = new URL(
  "../src/brand/studiotune-brand.css",
  import.meta.url,
);
const BRAND_CSS = readFileSync(BRAND_CSS_PATH, "utf8");

/** Extract the value of a `--token: value;` declaration. */
function readVar(css: string, name: string): string | null {
  // Match up to the terminating semicolon, tolerating whitespace.
  const pattern = new RegExp(`${escapeForRegex(name)}\\s*:\\s*([^;]+);`);
  const match = css.match(pattern);
  return match ? match[1].trim() : null;
}

function escapeForRegex(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const REQUIRED_TOKENS: Record<string, string> = {
  "--ai-bg": "#05060a",
  "--ai-panel": "#090c11",
  "--ai-surface": "#0c1016",
  "--ai-raised": "#11151e",
  "--ai-accent": "#a9c7ff",
  "--ai-text": "#f1f4fa",
  "--ai-muted": "#919aaa",
  "--ai-faint": "#757a82",
  "--ai-on-accent": "#04060a",
  "--ship-fg": "#5be39b",
  "--hold-fg": "#ffc857",
  "--revise-fg": "#ff9d66",
  "--reject-fg": "#ff6b7a",
  "--evidence-fg": "#5ed6d1",
};

for (const [token, expected] of Object.entries(REQUIRED_TOKENS)) {
  test(`brand token ${token} is locked to ${expected}`, () => {
    const value = readVar(BRAND_CSS, token);
    assert.equal(
      value?.toLowerCase(),
      expected.toLowerCase(),
      `${token} must be ${expected} to stay on-brand`,
    );
  });
}

test("StudioTune wordmark font stack includes the display serif", () => {
  const value = readVar(BRAND_CSS, "--studiotune-font-display");
  assert.ok(value, "--studiotune-font-display must be declared");
  assert.match(
    value ?? "",
    /Iowan Old Style/,
    "wordmark stack must lead with Iowan Old Style",
  );
  assert.match(
    value ?? "",
    /Palatino/,
    "wordmark stack must fall through Palatino",
  );
});

test("UI font stack leads with Poppins and mono with IBM Plex Mono", () => {
  const ui = readVar(BRAND_CSS, "--studiotune-font-ui") ?? "";
  const mono = readVar(BRAND_CSS, "--studiotune-font-mono") ?? "";
  assert.match(ui, /Poppins/i, "UI font stack must lead with Poppins");
  assert.match(
    mono,
    /IBM Plex Mono/i,
    "mono font stack must include IBM Plex Mono",
  );
});

test("HTML title is StudioTune, not Unsloth", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1] ?? "";
  assert.equal(title, "StudioTune");
});

test("Root document title fallback is StudioTune", () => {
  const source = readFileSync(
    new URL("../src/app/routes/__root.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const DEFAULT_DOCUMENT_TITLE = "StudioTune"/,
    "__root.tsx must fall back to a StudioTune document title",
  );
});

test("i18n shell.product / shell.brand say StudioTune", () => {
  const source = readFileSync(
    new URL("../src/i18n/locales/en.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /brand:\s*"StudioTune"/);
  assert.match(source, /product:\s*"StudioTune"/);
});

test("index.css remaps Unsloth chrome to StudioTune tokens", () => {
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  assert.match(css, /StudioTune chrome remap/);
  assert.match(css, /--primary:\s*#a9c7ff/);
  assert.match(css, /--background:\s*#05060a/);
  assert.match(css, /--sidebar:\s*#090c11/);
  assert.match(css, /Poppins/);
  assert.match(css, /IBM Plex Mono/);
});

test("sidebar wordmark goes to Home and footer is not Unsloth", () => {
  const source = readFileSync(
    new URL("../src/components/app-sidebar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /to=["']\/home["']/);
  assert.match(source, /nav-row-home/);
  assert.match(source, /t\(["']shell\.product["']\)/);
  assert.doesNotMatch(
    source,
    />Unsloth</,
    "sidebar must not render a literal Unsloth wordmark",
  );
});

test("post-auth lands on Home, not Chat", () => {
  const source = readFileSync(
    new URL("../src/features/auth/session.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /return "\/home"/);
  assert.doesNotMatch(source, /return "\/chat"/);
});
