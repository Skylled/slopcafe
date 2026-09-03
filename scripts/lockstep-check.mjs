// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// A soft, non-blocking nudge for GitHub issue #56.
//
// CLAUDE.md and CONTRIBUTING.md already document, in prose, several groups of
// files that are supposed to move together — an MCP tool-description change
// that should also touch docs/http-api.md and skills/publishing.md, a new
// migration that should also touch CLAUDE.md's Storage model paragraph and
// README.md's migrations line, and so on. Nothing enforced that pairing
// mechanically; a commit could forget a sibling file entirely and nothing
// would say so until a human noticed the prose had drifted.
//
// This script is NOT a drift detector — it can't tell whether a doc's prose
// is still ACCURATE (that's a judgment call, permanently out of a mechanical
// check's reach; see docs/design/action-plan-v1.md and the "89% agrees" style
// of every *-design.md write-up in this repo). It only answers one narrower,
// purely mechanical question: did this change touch SOME of a lockstep
// group's files without touching ANY of the others? If so, print a
// `::warning::` annotation naming what was touched and what wasn't, and keep
// going. It never fails a build — see the "Exit 0 always" note below.
//
// USAGE
//   git diff --name-only <base>...<head> | node scripts/lockstep-check.mjs
//   node scripts/lockstep-check.mjs <path> <path> ...      # argv form
//   node scripts/lockstep-check.mjs --self-test            # unit tests (npm run test:lockstep)
//
// GROUP SHAPE. Two kinds:
//
//   "directional" — a `trigger` file set (code) and a `companions` file set
//   (docs). Warns only when a TRIGGER file is touched and NONE of the
//   companions are (companions are an OR: touching any one of them is enough
//   to satisfy the group — CLAUDE.md's own obligations often name two or
//   three places a change should land, and this check only wants to catch
//   the sharper failure of forgetting the doc side ENTIRELY, not adjudicate
//   which specific sibling was the "right" one). A docs-only touch never
//   warns — companions are never triggers themselves. This also gives
//   `openapi.json` its documented pass: it's generated output, and
//   test/openapi.test.mjs already gates its freshness; naming it as one of
//   two possible companions means touching it alone (e.g. a routine
//   `npm run build:openapi`) satisfies the group without also demanding
//   prose in docs/http-api.md.
//
//   "symmetric" — a flat `members` list where every member is equally a
//   sibling of every other (e.g. the two setup guides, which CLAUDE.md says
//   must stay "command-for-command in lockstep" with each other — neither is
//   more "code" than the other). Warns when a STRICT SUBSET of members is
//   touched (some but not all).
//
// GROUPS ARE DELIBERATELY NARROW. CLAUDE.md itself warns that nuisance
// warnings train click-through (the Door A "judgable client identity"
// design uses the same principle for red-vs-neutral cues) — a group that
// fires on every commit stops meaning anything. Each group below traces to
// one specific CLAUDE.md/CONTRIBUTING.md obligation; extending the table
// should cite the sentence it encodes.

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// The lockstep table.

const GROUPS = [
  {
    name: "api-wire-surface",
    kind: "directional",
    trigger: ["src/contract.ts", "src/openapi.ts", "src/index.ts", "src/admin.ts", "src/admin-oauth.ts"],
    companions: ["docs/http-api.md", "openapi.json"],
    hint:
      'an HTTP wire-surface change usually needs docs/http-api.md updated and/or a regenerated openapi.json (CLAUDE.md: "Any API-surface change must update the MCP tool descriptions AND the HTTP API reference in the same commit")',
  },
  {
    name: "mcp-tool-surface",
    kind: "directional",
    trigger: ["src/mcp.ts"],
    companions: ["docs/http-api.md", "skills/publishing.md"],
    hint:
      "an MCP tool-description change usually needs docs/http-api.md's MCP section and skills/publishing.md kept in step (same CLAUDE.md rule, items 4-5)",
  },
  {
    name: "sanitizer-allowlist",
    kind: "directional",
    trigger: ["sanitizer/src/lib.rs"],
    companions: ["skills/publishing.md"],
    hint:
      'an allowlist change in make_builder() usually needs skills/publishing.md kept in sync (CLAUDE.md: "Keep in sync with the sanitizer allowlist")',
  },
  {
    name: "sanitizer-markdown-emitter",
    kind: "directional",
    trigger: ["sanitizer/src/markdown.rs"],
    companions: ["skills/publishing.md"],
    hint:
      "an emitted-bytes change here needs converter_version() bumped and skills/publishing.md's X-Converter-Version guidance kept accurate (CLAUDE.md's converter_version bullet)",
  },
  {
    name: "schema-migrations",
    kind: "directional",
    trigger: ["migrations/*.sql"],
    companions: ["CLAUDE.md", "README.md"],
    hint:
      'a new migration usually needs the CLAUDE.md Storage model paragraph and README.md\'s migrations line updated (CLAUDE.md: "Keep this CLAUDE.md current too" / "Same pairing for README.md")',
  },
  {
    name: "setup-guides",
    kind: "symmetric",
    members: ["docs/cloudflare-setup.md", "docs/agent-setup-runbook.md"],
    hint:
      'these two guides are meant to stay command-for-command in lockstep (CLAUDE.md: "Keep command-for-command in lockstep with cloudflare-setup.md in the same commit")',
  },
];

// ---------------------------------------------------------------------------
// Matching. Patterns are exact paths, or a single `*` wildcard confined to one
// path segment (`migrations/*.sql`) — migrations is a flat directory, and a
// segment-confined wildcard is enough for every group here; nothing needs
// recursive globbing.

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function matches(path, pattern) {
  return pattern.includes("*") ? globToRegExp(pattern).test(path) : path === pattern;
}

function filesMatchingAny(changedPaths, patterns) {
  return changedPaths.filter((c) => patterns.some((p) => matches(c, p)));
}

// ---------------------------------------------------------------------------
// Pure evaluation: changed paths + the group table -> warnings. Exported so
// --self-test can drive it directly without going through process stdio.

export function evaluateGroups(changedPaths, groups = GROUPS) {
  const warnings = [];
  for (const g of groups) {
    if (g.kind === "directional") {
      const touched = filesMatchingAny(changedPaths, g.trigger);
      if (touched.length === 0) continue; // no trigger touched — never warn on docs alone
      const companionsTouched = filesMatchingAny(changedPaths, g.companions);
      if (companionsTouched.length > 0) continue; // at least one sibling moved too
      warnings.push({ group: g.name, touched, untouched: g.companions, hint: g.hint });
    } else if (g.kind === "symmetric") {
      const touched = filesMatchingAny(changedPaths, g.members);
      if (touched.length === 0 || touched.length === g.members.length) continue; // none or all — fine
      const untouched = g.members.filter((m) => !touched.includes(m));
      warnings.push({ group: g.name, touched, untouched, hint: g.hint });
    } else {
      throw new Error(`lockstep-check: unknown group kind "${g.kind}" in group "${g.name}"`);
    }
  }
  return warnings;
}

function formatWarning(w) {
  const touchedList = w.touched.join(", ");
  const untouchedList = w.untouched.join(" or ");
  const message = `lockstep: touched ${touchedList} without touching ${untouchedList} — ${w.hint}`;
  return `::warning title=Lockstep nudge (${w.group})::${message}`;
}

// ---------------------------------------------------------------------------
// CLI

function readChangedPathsFromStdin() {
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    input = ""; // no stdin attached (e.g. a TTY with nothing piped) — treat as empty
  }
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const pathArgs = args.filter((a) => !a.startsWith("--"));
  const changedPaths = pathArgs.length > 0 ? pathArgs : readChangedPathsFromStdin();

  // This is a nudge, never a gate — swallow any internal error rather than
  // letting it fail a CI step that promises never to fail.
  try {
    for (const w of evaluateGroups(changedPaths)) {
      console.log(formatWarning(w));
    }
  } catch (err) {
    console.log(`::warning::lockstep-check: internal error, skipping (${err instanceof Error ? err.message : String(err)})`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --self-test — a small table-driven unit test over the REAL group table
// above (not a synthetic stand-in), wired into `npm test` as `test:lockstep`.
// Unlike the nudge path, this DOES fail (non-zero exit) on a wrong result —
// that's the point of it being a test.

function runSelfTest() {
  let fails = 0;
  function check(label, cond) {
    console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
    if (!cond) fails++;
  }
  function checkSameSet(label, got, want) {
    const g = [...got].sort();
    const w = [...want].sort();
    check(label, JSON.stringify(g) === JSON.stringify(w));
  }
  function warningFor(warnings, groupName) {
    return warnings.find((w) => w.group === groupName);
  }

  // Case 1: directional trigger touched, no companion touched -> warns, and
  // names exactly the touched trigger + the full (untouched) companion list.
  {
    const warnings = evaluateGroups(["src/mcp.ts"]);
    const w = warningFor(warnings, "mcp-tool-surface");
    check("case1: mcp.ts alone warns mcp-tool-surface", Boolean(w));
    if (w) {
      checkSameSet("case1: touched = [src/mcp.ts]", w.touched, ["src/mcp.ts"]);
      checkSameSet("case1: untouched = both companions", w.untouched, ["docs/http-api.md", "skills/publishing.md"]);
    }
    check("case1: no unrelated groups fire", warnings.length === 1);
  }

  // Case 2: trigger + ONE of two companions (OR semantics) -> satisfied, no warning.
  {
    const warnings = evaluateGroups(["src/mcp.ts", "skills/publishing.md"]);
    check("case2: trigger + one companion satisfies the group", !warningFor(warnings, "mcp-tool-surface"));
  }

  // Case 3: docs-only touch never warns — a companion is never itself a trigger.
  {
    const warnings = evaluateGroups(["docs/http-api.md"]);
    check("case3: docs-only touch produces no warnings at all", warnings.length === 0);
  }

  // Case 4: glob trigger (migrations/*.sql) fires like any other trigger, and
  // is satisfied by either declared companion (here: only README.md moved).
  {
    const noCompanion = evaluateGroups(["migrations/0019_test.sql"]);
    const wNone = warningFor(noCompanion, "schema-migrations");
    check("case4a: a new migration alone warns schema-migrations", Boolean(wNone));
    if (wNone) checkSameSet("case4a: touched names the actual migration file", wNone.touched, ["migrations/0019_test.sql"]);

    const withReadme = evaluateGroups(["migrations/0019_test.sql", "README.md"]);
    check("case4b: migration + README.md satisfies the group", !warningFor(withReadme, "schema-migrations"));
  }

  // Case 5: symmetric group — strict subset (one of two) warns; both, or
  // neither, do not.
  {
    const oneOnly = evaluateGroups(["docs/cloudflare-setup.md"]);
    const w = warningFor(oneOnly, "setup-guides");
    check("case5a: one of two setup guides warns", Boolean(w));
    if (w) {
      checkSameSet("case5a: touched = the one file", w.touched, ["docs/cloudflare-setup.md"]);
      checkSameSet("case5a: untouched = the sibling", w.untouched, ["docs/agent-setup-runbook.md"]);
    }

    const both = evaluateGroups(["docs/cloudflare-setup.md", "docs/agent-setup-runbook.md"]);
    check("case5b: both setup guides together do not warn", !warningFor(both, "setup-guides"));

    const neither = evaluateGroups(["README.md"]);
    check("case5c: neither setup guide touched does not warn", !warningFor(neither, "setup-guides"));
  }

  // Case 6: an unrelated change set produces zero warnings — the common case
  // in CI must stay quiet.
  {
    const warnings = evaluateGroups(["src/depth.ts", "test/depth.test.mjs"]);
    check("case6: an unrelated diff is silent", warnings.length === 0);
  }

  if (fails > 0) {
    console.log(`\n${fails} lockstep-check self-test(s) FAILED`);
    return 1;
  }
  console.log("\nall lockstep-check self-tests passed");
  return 0;
}

if (process.argv.slice(2).includes("--self-test")) {
  process.exit(runSelfTest());
} else {
  main();
}
