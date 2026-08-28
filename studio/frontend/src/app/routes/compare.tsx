// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

import { ComparePage } from "@/features/compare";
import { createRoute } from "@tanstack/react-router";
import { requireAuth } from "../auth-guards";
import { Route as rootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/compare",
  staticData: { title: "Compare" },
  beforeLoad: () => requireAuth(),
  component: ComparePage,
});
