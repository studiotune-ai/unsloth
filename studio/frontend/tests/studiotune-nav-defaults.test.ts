// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

/**
 * StudioTune primary-nav contract. The train studio (train / recipes /
 * export / compare) leads the sidebar; the chat-era rows are demoted to
 * "More" by default. Locking these here catches a driveby that would put
 * Chat or Hub back at the top of a fresh install.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CUSTOMIZATION,
  SIDEBAR_NAV_DEFAULT_PINNED,
  SIDEBAR_NAV_ITEM_IDS,
} from "../src/features/settings/stores/appearance-custom-store.ts";

test("primary rail pinned rows are train, recipes, export, compare", () => {
  const pinned = SIDEBAR_NAV_ITEM_IDS.filter(
    (id) => SIDEBAR_NAV_DEFAULT_PINNED[id],
  );
  assert.deepEqual(pinned, ["train", "recipes", "export", "compare"]);
});

test("chat-era rows are demoted (unpinned by default) but still reachable", () => {
  for (const id of [
    "projects",
    "hub",
    "images",
    "video",
    "audio",
    "api",
  ] as const) {
    assert.equal(
      SIDEBAR_NAV_DEFAULT_PINNED[id],
      false,
      `${id} must NOT be pinned in the StudioTune default primary rail`,
    );
    assert.ok(
      SIDEBAR_NAV_ITEM_IDS.includes(id),
      `${id} must still be listed so users can pin it back via Settings`,
    );
  }
});

test("compare is a first-class primary-nav id", () => {
  assert.ok(
    SIDEBAR_NAV_ITEM_IDS.includes("compare"),
    "compare must be in SIDEBAR_NAV_ITEM_IDS",
  );
  assert.equal(SIDEBAR_NAV_DEFAULT_PINNED.compare, true);
});

test("DEFAULT_CUSTOMIZATION.sidebarNav mirrors the id/pinned defaults", () => {
  const idsInOrder = DEFAULT_CUSTOMIZATION.sidebarNav.map((entry) => entry.id);
  assert.deepEqual(idsInOrder, [...SIDEBAR_NAV_ITEM_IDS]);
  for (const entry of DEFAULT_CUSTOMIZATION.sidebarNav) {
    assert.equal(entry.pinned, SIDEBAR_NAV_DEFAULT_PINNED[entry.id]);
  }
});
