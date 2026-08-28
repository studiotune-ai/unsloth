# StudioTune Desktop rebrand + Clusy Home (2026-08-28)

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

- Remapped Unsloth chrome (`--primary` green, `--background` warm-white, Inter/Hellix) to locked StudioTune tokens (`--ai-bg #05060a`, `--ai-accent #a9c7ff`, Poppins / IBM Plex Mono / Iowan). Default theme is dark ST.
- Home is the front door: post-auth and wordmark land on `/home`. Sidebar has a pinned Home row. Experiment rail labels: Home, Models, Datasets, Train/Runs, Evidence, Export.
- Footer wordmark is StudioTune. en.ts product copy says StudioTune except CLI/env/AGPL.
- Clusy-adapted local flow on the existing Home + Tune Agent rail (not a Clusy fork): first prompt on Home; after a plan exists the conversation is handed to the rail; PlanCard is the canvas (revise / drop / discard / branch_from); Accept applies a recipe locally and then follows into `/studio`; neither branch runs; no Hub / cloud GPU / credits / publish.

## What still looks Unsloth

- Host routes, storage keys, CLI (`unsloth start`, `unsloth studio update`), env vars, AGPL headers, and Hugging Face `unsloth/` model ids stay — this is still the Unsloth Tauri/train fork.
- Chat / Images / Video / Audio still exist under More.
- Sloth mascot assets and some Unsloth class names (`unsloth-plus-menu`) remain.
- About/update copy that describes the actual `unsloth` CLI is still honest about the host command.

## Tests / screenshot

- screenshot: none this hop (no rebuild, no sign).
- StudioTune-focused tests: 61/61 pass (brand, home, rail, nav, clusy session) plus 55/55 on the remediating rerun (surface/mic/nav/brand/clusy).
- Full frontend suite (node --test on tests/*.test.ts): 5343 tests, 5305 pass, 38 fail before remediating two we caused (popover/card parity, mic page copy). Those two now pass. Remaining fails look pre-existing (openai-codex-connect missing module, training-dataset-source-transitions, model-catalog/vite loads) — not re-run in full after the two fixes.
