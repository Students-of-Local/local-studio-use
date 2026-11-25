/**
 * The CLI ships as one ES module bundle (scripts/build.mjs). `ws` and `cross-spawn` are CommonJS and require Node
 * built-ins, which a bundled ES module can't do without a `require`. Import this before importing
 * `ws` and the bundle has one.
 */

import { createRequire } from "node:module";

const scope = globalThis as { require?: NodeJS.Require };
scope.require ??= createRequire(import.meta.url);
