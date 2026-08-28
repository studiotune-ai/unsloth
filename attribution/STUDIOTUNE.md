# StudioTune Desktop attribution

StudioTune Desktop is the Ainfera-published desktop **host** for StudioTune. It
is derived from **Unsloth Studio**. The upstream Unsloth code — everything
under `studio/*` and `unsloth_cli/*` — remains AGPL-3.0-only. See
`studio/LICENSE.AGPL-3.0` and top-level `COPYING`.

## Provenance

- Upstream repository: <https://github.com/unslothai/unsloth>
- Upstream license: AGPL-3.0-only for the Studio (`studio/`) and CLI
  (`unsloth_cli/`) code, Apache-2.0 for the core Unsloth training library
  (`unsloth/`). Do not relicense Apache-licensed code.
- Ainfera Inc. distributes StudioTune Desktop as a derivative host. The
  StudioTune-specific host chrome (`studio/frontend/src/brand/*`,
  `studio/frontend/src/features/tune-agent/*`, `studio/frontend/src/features/compare/*`)
  is © 2026 Ainfera Inc. and is also released under AGPL-3.0-only to remain
  compatible with the upstream Studio license.

## What StudioTune Desktop keeps from Unsloth

- Every existing copyright and license header in `studio/*` and `unsloth_cli/*`.
- The full train / data-recipe / recipe-studio / export code paths. These are
  the primary product surface in StudioTune, so nothing is deleted; they only
  gain the StudioTune host chrome around them.
- The `unsloth/*` Apache-2.0 training core, verbatim. No relicensing.

## What StudioTune Desktop changes

- Brand identity: product name, window title, deep-link scheme, dock/tray
  tooltip, HTML `<title>`, i18n `shell.product` / `shell.brand`, wordmark.
- Bundle identifier: `ai.studiotune.desktop`.
- Auto-updater: disabled in this hop. All Unsloth release URLs have been
  removed from `studio/src-tauri/src/desktop_update_policy.rs` and
  `studio/src-tauri/tauri.conf.json`.
- Primary navigation: Train / Recipes / Export / Compare surface up top.
  Chat / Hub / Images / Video / Audio / API keep their code and stay
  reachable through the "More" flyout.
- Tune Agent rail: new persistent right-side panel with Ask / Plan / Agent
  modes. IPC to the separate `studiotune-ai/tune-agent` process is stubbed
  fail-closed in this hop — the rail renders an honest HOLD state when the
  agent is not connected.

## HOLD note

This is a HOLD build. It is not signed, not notarized, and not published.
Tune Agent live IPC and Compare fixtures land in follow-up hops.
