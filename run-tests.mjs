import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";

/**
 * Tests are TypeScript and import from `src`, so they are bundled once and handed
 * to `node --test`. Node builtins stay external; nothing else is allowed in.
 */

const outdir = ".test-build";
const outfile = `${outdir}/tests.mjs`;

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
  entryPoints: ["test/index.ts"],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  packages: "external",
  sourcemap: "inline",
  logLevel: "warning",
});

const args = ["--test", "--test-reporter=spec"];
if (process.argv.includes("--only")) args.push("--test-only");
args.push(outfile);

const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
