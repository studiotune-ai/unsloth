# Look-strip + stdio plan HOLD (2026-08-28 20:06 WIB)

- host: HizrianacStudio.localdomain
- branch: cursor/studiotune-desktop-rebrand-faf5
- pr: https://github.com/studiotune-ai/unsloth/pull/1
- beta_ready_claim: false
- authority: false
- action_taken: false
- signed: false
- notarized: false
- published: false
- merged: false
- hub_contacted: false
- cloud_agent: false

## What changed

- Killed leftover Hellix / Inter / Space Grotesk as the live UI face. Poppins + IBM Plex Mono + Iowan only.
- Killed Unsloth green `#17b88b` as the live accent. Locked `--ai-accent #a9c7ff`, `--ai-bg #05060a`.
- Replaced visible Unsloth wordmarks / splash / empty-state / footer-ish copy with StudioTune. AGPL Unsloth AI Inc. headers kept.
- Wired `tune_agent_request_plan` to sidecar `--stdio-json` `plan` (show-only, authority=false, action_taken=false). Did not add train/admit/agent over stdio.

## Running window

- screenshot: docs/receipts/studiotune-look-strip-plan-2026-08-28.png
- CG window 148509 title=StudioTune pid=63787 1920x1187
- Home is the front door in that window (already from the three-way adapt).
- stdio plan is NOT live in that window: cargo build --release was Auto-review blocked, so the 19:18 adhoc binary was not replaced.

## Tests

- StudioTune contracts: 100/100 pass
- Rust tune_agent: 39/39 pass including live sidecar plan
- Full frontend suite: 5357 tests, 5355 pass, 2 fail (overlay copy now fixed 11/11; remaining shiki tokenization fail is pre-existing)
