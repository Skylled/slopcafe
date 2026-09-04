// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Input coercion shared by MCP tool modules.
 *
 * Some connectors encode numeric and boolean fields as strings, even
 * inconsistently within one call. Coerce those observed wire forms before
 * validation while keeping the advertised JSON Schema typed as number/boolean.
 * Apply one of these helpers to every new numeric or boolean MCP argument.
 */

import { z } from "zod";

export const coerceInt = <T extends z.ZodTypeAny>(inner: T, description: string) =>
  z
    .preprocess((v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v), inner)
    .describe(description);

export const coerceBool = <T extends z.ZodTypeAny>(inner: T, description: string) =>
  z
    .preprocess((v) => (v === "true" ? true : v === "false" ? false : v), inner)
    .describe(description);
