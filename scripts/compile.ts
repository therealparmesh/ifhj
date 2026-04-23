#!/usr/bin/env bun
/**
 * Compile ifhj to a standalone binary.
 *
 * Ink imports `react-devtools-core` when `DEV=true` is in the shell. Bundling
 * the real package pulls ~16MB; `--external` leaves a runtime-unresolvable
 * import that crashes the binary. We stub it at build time instead — zero
 * runtime cost, no devtools dep, safe regardless of shell state.
 *
 * Optional first arg is a cross-compile target (e.g. `bun-linux-arm64`) — the
 * release workflow passes one per matrix entry. Omit for host-native builds.
 */
import { resolve } from "node:path";

type CompileTarget = NonNullable<
  Extract<Parameters<typeof Bun.build>[0]["compile"], object>["target"]
>;

const repoRoot = resolve(import.meta.dir, "..");
const outfile = resolve(repoRoot, "ifhj");
const target = process.argv[2] as CompileTarget | undefined;

const result = await Bun.build({
  entrypoints: [resolve(repoRoot, "src/index.tsx")],
  compile: target ? { outfile, target } : { outfile },
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
