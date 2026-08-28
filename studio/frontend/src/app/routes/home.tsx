// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

import { HomeComposer } from "@/features/home";
import { createRoute } from "@tanstack/react-router";
import { requireAuth } from "../auth-guards";
import { Route as rootRoute } from "./__root";

/**
 * StudioTune Home — the one-prompt composer surface. Draws a plan card
 * client-side; nothing here calls Engine, the Hub, or the network. Kept
 * separate from `/studio` so the train studio's wizard state does not have
 * to reason about a Clusy-style composer stealing focus.
 */
export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/home",
  staticData: { title: "Home" },
  beforeLoad: () => requireAuth(),
  component: HomeComposer,
});
