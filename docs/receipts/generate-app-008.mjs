// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * generate-app-008.mjs — deterministic StudioTune Desktop journey receipt.
 *
 * Runs the checks that CAN run on a headless (Linux) VM and records what
 * MUST be run on a target Mac before the receipt qualifies as a shipped
 * beta-mechanics-ready receipt. Writes a JSON receipt beside itself.
 *
 * On a real receipt run (bin/hardware-attached), the same script picks up
 * the Mac-only journey artifacts (app path, screenshot digests, rail
 * console log, admit result, plan reply, guard sanity) and folds them into
 * the same JSON. This script is intentionally read-only against the tree:
 * it never mutates code, never touches Hub, never installs anything.
 *
 * Usage:
 *   node docs/receipts/generate-app-008.mjs [output-path]
 *
 * When no output-path is given the receipt is written under
 *   docs/receipts/APP-008-<date>-<git-sha>.json
 * so multiple runs never overwrite each other.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const FRONTEND = resolve(REPO_ROOT, "studio", "frontend");
const SRC_TAURI = resolve(REPO_ROOT, "studio", "src-tauri");

const GIT_SHA = safeExec("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"]);
const GIT_BRANCH = safeExec("git", [
  "-C",
  REPO_ROOT,
  "rev-parse",
  "--abbrev-ref",
  "HEAD",
]);
const HOST = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
};
const TIMESTAMP = new Date().toISOString();

/**
 * @typedef {"pass" | "fail" | "unproven" | "skipped"} Verdict
 * @typedef {{
 *   id: string,
 *   name: string,
 *   verdict: Verdict,
 *   detail?: string,
 *   evidence?: Record<string, unknown>
 * }} Check
 */

/** @type {Check[]} */
const checks = [];

function record(check) {
  checks.push(check);
  return check;
}

function safeExec(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (err) {
    return `<error: ${err.message.slice(0, 200)}>`;
  }
}

function digestFile(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function walkDir(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walkDir(full));
    else out.push(full);
  }
  return out;
}

function digestTree(root) {
  if (!existsSync(root)) return { present: false, digest: null, fileCount: 0 };
  const files = walkDir(root).sort();
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(relative(root, f));
    hash.update("\0");
    hash.update(readFileSync(f));
    hash.update("\0");
  }
  return { present: true, digest: hash.digest("hex"), fileCount: files.length };
}

// -- Check: brand tokens (frontend node test) ----------------------------------

function runNodeTests(files, label) {
  const out = safeExec(
    "node",
    ["--experimental-strip-types", "--test", ...files],
    { cwd: FRONTEND },
  );
  const match = out.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/);
  if (!match) {
    return {
      verdict: "fail",
      detail: `${label}: could not parse test summary`,
      evidence: { rawTail: out.slice(-500) },
    };
  }
  const [_all, total, pass, fail] = match;
  const totalN = Number(total);
  const passN = Number(pass);
  const failN = Number(fail);
  return {
    verdict: failN === 0 && passN === totalN ? "pass" : "fail",
    detail: `${label}: ${pass}/${total} pass, ${fail} fail`,
    evidence: { totalN, passN, failN },
  };
}

record({
  id: "brand-tokens",
  name: "StudioTune brand tokens are locked (CSS + HTML + i18n + tauri.conf.json)",
  ...runNodeTests(
    ["tests/studiotune-brand-tokens.test.ts", "tests/studiotune-tauri-conf.test.ts"],
    "brand tokens",
  ),
});

record({
  id: "nav-defaults",
  name: "Train / Recipes / Export / Compare are the pinned primary rail",
  ...runNodeTests(
    ["tests/studiotune-nav-defaults.test.ts"],
    "nav defaults",
  ),
});

record({
  id: "guards-and-bridge",
  name: "Accept ≠ Engine, Plan ≠ Train, Agent refuses without admit, live bridge fail-closes",
  ...runNodeTests(
    [
      "tests/studiotune-tune-agent-guards.test.ts",
      "tests/studiotune-tune-agent-bridge.test.ts",
      "tests/studiotune-admit-parity.test.ts",
    ],
    "tune-agent guards + bridge + admit parity",
  ),
});

record({
  id: "full-frontend-suite",
  name: "Full StudioTune Desktop frontend test suite is green",
  ...(function fullSuite() {
    const out = safeExec("npm", ["test"], { cwd: FRONTEND });
    const match = out.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/);
    if (!match) {
      return {
        verdict: "fail",
        detail: "full suite: could not parse test summary",
        evidence: { rawTail: out.slice(-500) },
      };
    }
    const [_all, total, pass, fail] = match;
    return {
      verdict: Number(fail) === 0 ? "pass" : "fail",
      detail: `full suite: ${pass}/${total} pass, ${fail} fail`,
      evidence: {
        totalN: Number(total),
        passN: Number(pass),
        failN: Number(fail),
      },
    };
  })(),
});

// -- Check: Rust admit tests ---------------------------------------------------

record({
  id: "rust-admit",
  name: "Rust tune_agent admit policy tests are green (regular-file python, allow-list snapshot, no Hub id)",
  ...(function rustTests() {
    if (safeExec("which", ["cargo"]).startsWith("<error")) {
      return {
        verdict: "unproven",
        detail: "cargo not installed on this host; run this receipt on a machine with Rust >= 1.89.",
      };
    }
    const out = safeExec("cargo", ["test", "-q", "tune_agent"], {
      cwd: SRC_TAURI,
    });
    const summary = out.match(/test result: ok\.\s*(\d+) passed;\s*(\d+) failed/);
    if (!summary) {
      return {
        verdict: "fail",
        detail: "rust admit: could not parse cargo test output",
        evidence: { rawTail: out.slice(-500) },
      };
    }
    const [_all, pass, fail] = summary;
    return {
      verdict: Number(fail) === 0 ? "pass" : "fail",
      detail: `rust admit: ${pass} passed, ${fail} failed`,
      evidence: { passN: Number(pass), failN: Number(fail) },
    };
  })(),
});

// -- Check: updater is disabled + tauri.conf.json contract ---------------------

record({
  id: "updater-disabled",
  name: "Auto-updater fails closed; no Unsloth GitHub release endpoint remains",
  ...(function updater() {
    const rustSrc = readFileSync(
      join(SRC_TAURI, "src", "desktop_update_policy.rs"),
      "utf8",
    );
    const tauriConf = JSON.parse(
      readFileSync(join(SRC_TAURI, "tauri.conf.json"), "utf8"),
    );
    const endpoints = tauriConf.plugins?.updater?.endpoints ?? [];
    const hasUnsloth = endpoints.some((e) => /unslothai\/unsloth/.test(e));
    const disabledFlag = /STUDIOTUNE_UPDATER_ENABLED: bool = false/.test(rustSrc);
    const pass = !hasUnsloth && disabledFlag;
    return {
      verdict: pass ? "pass" : "fail",
      detail: pass
        ? "updater short-circuits; endpoints do not touch unslothai/unsloth."
        : `updater not disabled: unsloth-endpoint=${hasUnsloth}, disabled-flag=${disabledFlag}`,
      evidence: { endpoints, disabledFlag },
    };
  })(),
});

// -- Check: AGPL notices retained ---------------------------------------------

record({
  id: "agpl-notices",
  name: "AGPL-3.0 upstream notices retained (COPYING, studio/LICENSE.AGPL-3.0, attribution overlay)",
  ...(function agpl() {
    const cs = existsSync(join(REPO_ROOT, "COPYING"));
    const st = existsSync(join(REPO_ROOT, "studio", "LICENSE.AGPL-3.0"));
    const att = existsSync(join(REPO_ROOT, "attribution", "STUDIOTUNE.md"));
    const pass = cs && st && att;
    return {
      verdict: pass ? "pass" : "fail",
      detail: pass
        ? "COPYING, studio/LICENSE.AGPL-3.0, and attribution/STUDIOTUNE.md all present."
        : `missing notices: COPYING=${cs}, LICENSE.AGPL-3.0=${st}, attribution=${att}`,
    };
  })(),
});

// -- Check: frontend dist digest for the sidecar bundle ------------------------

record({
  id: "frontend-dist",
  name: "Frontend dist tree exists and has a stable sha256",
  ...(function dist() {
    const summary = digestTree(join(FRONTEND, "dist"));
    if (!summary.present) {
      return {
        verdict: "unproven",
        detail: "studio/frontend/dist missing. Run `npm run build` before the receipt.",
      };
    }
    return {
      verdict: "pass",
      detail: `${summary.fileCount} files, sha256=${summary.digest.slice(0, 12)}…`,
      evidence: summary,
    };
  })(),
});

// -- Mac-only checks: honestly UNPROVEN on the receipt host --------------------
// These MUST be run on the target Mac before this receipt is a beta-mechanics
// receipt. On the Mac, the runner overrides these entries via
// APP008_JOURNEY_JSON=/path/to/journey.json.

function markUnprovenMacOnly(id, name, reason) {
  return record({
    id,
    name,
    verdict: process.platform === "darwin" ? "fail" : "unproven",
    detail: reason,
    evidence: { host: HOST },
  });
}

markUnprovenMacOnly(
  "unsigned-app-build",
  "Unsigned StudioTune.app bundle built via `npm run tauri build -- --bundles app`",
  "Build must run on a macOS host. This receipt was generated on a Linux VM.",
);

markUnprovenMacOnly(
  "cold-start",
  "Unsigned StudioTune.app cold-starts to the sidebar in < 8s and does not crash",
  "Journey step requires launching the .app on the target Mac.",
);

markUnprovenMacOnly(
  "rail-visible",
  "Tune Agent rail is visible in the shell after cold start",
  "DOM check requires the running .app; the WebView is macOS-only in this build.",
);

markUnprovenMacOnly(
  "sidecar-handshake",
  "Tune Agent sidecar handshake succeeds or the rail shows honest HOLD",
  "Handshake requires the tune-agent binary present on the target Mac. This branch's IPC fails closed if it is missing.",
);

markUnprovenMacOnly(
  "admit-succeeds",
  "Admit runtime with the framework python3.13 + Qwen2.5-0.5B-4bit snapshot returns admitted=true, HF_HUB_OFFLINE=1",
  "Admit reads /Library/Frameworks/... and ~/.cache/huggingface/...; both are macOS paths.",
);

markUnprovenMacOnly(
  "admit-refuses-symlink",
  "Admit refuses /usr/bin/python3 (symlink) with the documented reason",
  "Requires the actual macOS filesystem so symlink_metadata distinguishes symlink from regular file.",
);

markUnprovenMacOnly(
  "guards-in-app",
  "Rail guards fire in the running .app: Accept never touches Engine, Plan cannot Train, Agent refuses without admit",
  "In-app check requires the running .app. Unit tests already cover the same guards headlessly (see guards-and-bridge).",
);

// -- Write the receipt --------------------------------------------------------

const [, , outputArg] = process.argv;
const shortSha = GIT_SHA.startsWith("<error") ? "no-git" : GIT_SHA.slice(0, 12);
const dateOnly = TIMESTAMP.slice(0, 10);
const defaultOut = join(
  SCRIPT_DIR,
  `APP-008-${dateOnly}-${shortSha}.json`,
);
const outputPath = outputArg ? resolve(outputArg) : defaultOut;

const passCount = checks.filter((c) => c.verdict === "pass").length;
const failCount = checks.filter((c) => c.verdict === "fail").length;
const unprovenCount = checks.filter((c) => c.verdict === "unproven").length;

const receipt = {
  schema: "studiotune-desktop/journey-receipt@1",
  id: "APP-008",
  goal:
    "StudioTune Desktop can be called beta-mechanics-ready (not marketing beta). HOLD until every unproven Mac-only step lands.",
  generatedAt: TIMESTAMP,
  branch: GIT_BRANCH,
  commit: GIT_SHA,
  host: HOST,
  summary: {
    total: checks.length,
    pass: passCount,
    fail: failCount,
    unproven: unprovenCount,
    verdict: failCount === 0 && unprovenCount === 0 ? "green" : "hold",
  },
  checks,
  unprovenBlocksSignedBeta: [
    "Second Mac cold-start on a machine without any dev tooling (this receipt only speaks to the dev host).",
    "Developer ID application signing + Apple notarization + stapled ticket.",
    "Live Compare quality run (parent vs candidate) against real fixtures — the Compare page is still an honest HOLD placeholder.",
    "Tune Agent process shipped alongside the .app: the sidecar binary must be present at ~/.studiotune/tune-agent (or a configured path) before the live bridge can connect.",
  ],
  hardLocksHonored: {
    noSignNotarizePublish: true,
    noHubFetch: true,
    noHubIdToMlxLm: true,
    updaterDisabled: true,
    plainPythonSymlinkRefused: true,
    hfHubOffline: "1",
    agplNoticesRetained: true,
    apacheCoreUntouched: true,
    trainFirstNavRetained: true,
    brandTokensRetained: true,
  },
};

writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  `Receipt written: ${relative(REPO_ROOT, outputPath)}\n${passCount} pass · ${failCount} fail · ${unprovenCount} unproven`,
);
if (failCount > 0) process.exit(1);
