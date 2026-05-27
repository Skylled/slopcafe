// Resolver hook for the `--experimental-strip-types` test runner.
//
// Why this exists: TypeScript with `moduleResolution: "Bundler"` (and ESBuild
// via wrangler) lets src/ files import each other with `.js` extensions even
// though the on-disk files are `.ts` — the convention every src/ file
// follows. Node's --experimental-strip-types loads .ts files but does NOT
// rewrite `./foo.js` → `./foo.ts` at resolve time (as of Node 22.x).
//
// Before pagination.ts had cross-file imports, all three tests
// (advisories/metadata/pagination) just worked because each src/ module they
// pulled was self-contained. Now pagination.ts imports metadata.ts, so we
// need to teach Node's resolver about the convention.
//
// Registered via package.json's `--import` flag on the test:pagination
// command. Other tests don't need it (yet) but it's harmless to apply
// uniformly if more cross-imports show up.
//
// The next() call: we ask the next resolver in the chain — pass through
// any errors so a `.ts` file that genuinely doesn't exist still 404s with
// the same diagnostic Node would normally produce.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    const tsSpecifier = specifier.slice(0, -3) + ".ts";
    try {
      const candidate = await nextResolve(tsSpecifier, context);
      if (candidate.url.startsWith("file://")) {
        const path = fileURLToPath(candidate.url);
        if (existsSync(path)) return candidate;
      }
    } catch {
      // .ts file doesn't exist either — fall through to default resolution
      // so Node can produce the canonical ERR_MODULE_NOT_FOUND.
    }
  }
  return nextResolve(specifier, context);
}
