// Tiny bootstrap that registers ts-resolver.mjs as a custom loader hook.
// Used via `node --import=./test/register-ts-resolver.mjs` in the
// test:pagination script — see ts-resolver.mjs for why the hook exists.
//
// Node's `--import` flag executes the referenced file BEFORE the entry
// point, with full access to the module-loader API. `register()` from
// node:module is the supported way to install a resolver hook in Node 22+
// (the older `--loader` flag is deprecated but still works).

import { register } from "node:module";
register("./ts-resolver.mjs", import.meta.url);
