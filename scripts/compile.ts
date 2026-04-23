#!/usr/bin/env bun
/**
 * Compile ifhj to a standalone binary.
 *
 * Ink imports `react-devtools-core` when `DEV=true` is in the shell. Bundling
 * the real package pulls ~16MB; `--external` leaves a runtime-unresolvable
 * import that crashes the binary. We stub it at build time instead — zero
 * runtime cost, no devtools dep, safe regardless of shell state.
 */
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

const result = await Bun.build({
  entrypoints: [resolve(repoRoot, "src/index.tsx")],
  compile: { outfile: resolve(repoRoot, "ifhj") },
  minify: true,
  plugins: [
    {
      name: "stub-react-devtools-core",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `export default { connectToDevTools: () => {}, initialize: () => {} };`,
          loader: "js",
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
