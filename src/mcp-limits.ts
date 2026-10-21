// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Count keys/elements, not string bytes: publish/update carry the document as
// one string (the write core caps it at 5 MiB), plus <=10 normalized tags.
// edit_document has the largest structure: 1,000 two-key edits cost 3,000
// elements, leaving room for tags and all top-level metadata under 4,096.
// Edits previously had no count cap; larger batches must now be split.
export const MAX_MCP_TOOL_INPUT_ELEMENTS = 4_096;
