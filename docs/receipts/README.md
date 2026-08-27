# StudioTune Desktop journey receipts

Each receipt in this folder is a JSON snapshot of a full StudioTune Desktop
journey run — headless checks plus, when available, in-app Mac steps. The
schema is stable (`studiotune-desktop/journey-receipt@1`) so a reviewer or CI
can diff two receipts and see exactly what changed.

## Layout

```
docs/receipts/
├── APP-008-<YYYY-MM-DD>-<git-sha>.json   # generated receipt (never overwritten)
├── generate-app-008.mjs                  # the receipt runner
└── README.md
```

## How to generate

From the repo root:

```bash
node docs/receipts/generate-app-008.mjs
```

The runner writes the receipt to
`docs/receipts/APP-008-<date>-<short-sha>.json` by default. Pass an explicit
output path as the first argument to override.

## What the runner does

The runner is intentionally read-only:

- Runs the four StudioTune contract test suites (`brand-tokens`,
  `nav-defaults`, `guards-and-bridge`, `admit-parity`) individually so a
  targeted failure is easy to attribute.
- Runs the full StudioTune Desktop frontend test suite.
- Runs `cargo test tune_agent` in `studio/src-tauri` for the admit-policy
  unit tests (regular-file python, allow-list snapshot, no Hub id, offline
  env).
- Confirms the auto-updater is disabled and no `unslothai/unsloth` endpoint
  remains in `tauri.conf.json`.
- Confirms `COPYING`, `studio/LICENSE.AGPL-3.0`, and
  `attribution/STUDIOTUNE.md` are all present.
- Digests the built `studio/frontend/dist` tree so a signed beta later can
  chain to this exact webview bundle.

## What the runner does NOT do

The runner never fetches from Hub, never signs, never launches the app on a
second Mac, and never installs anything.

## Verdicts

| Verdict     | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `pass`      | Check ran and succeeded on the receipt host.                   |
| `fail`      | Check ran and failed. Blocks a green receipt.                  |
| `unproven`  | Check requires the target Mac and could not run here yet.      |
| `skipped`   | Reserved for checks intentionally disabled by the runner.      |

A receipt is `green` only when `fail === 0` and `unproven === 0`. Anything
else is `hold`.

## Mac-only checks

`unproven` on the Linux VM is expected. On the target Mac these must move to
`pass` before the receipt qualifies as beta-mechanics-ready:

- `unsigned-app-build` — build the unsigned `StudioTune.app` bundle.
- `cold-start` — cold launch to the sidebar without crashing.
- `rail-visible` — Tune Agent rail is visible after cold start.
- `sidecar-handshake` — Tune Agent sidecar handshake succeeds, or the rail
  renders an honest HOLD state.
- `admit-succeeds` — admit runtime with the framework `python3.13` and the
  Qwen2.5-0.5B-Instruct-4bit snapshot returns `admitted: true` and
  `HF_HUB_OFFLINE=1`.
- `admit-refuses-symlink` — admit refuses `/usr/bin/python3` (symlink) with
  the documented reason.
- `guards-in-app` — Accept never touches Engine, Plan cannot Train, Agent
  refuses without admit, exercised inside the running `.app`.

## What still blocks a signed beta

Recorded verbatim in every receipt under `unprovenBlocksSignedBeta`:

- Second Mac cold-start on a machine without any dev tooling.
- Developer ID application signing + Apple notarization + stapled ticket.
- Live Compare quality run (parent vs candidate) against real fixtures.
- Tune Agent process shipped alongside the `.app`.
