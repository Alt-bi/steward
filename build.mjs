import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");
const outdir = "dist";

const pkg = JSON.parse(await readFile("package.json", "utf8"));

/** Static files are copied, not bundled. */
async function copyStatic() {
  const manifest = JSON.parse(await readFile("src/manifest.json", "utf8"));
  manifest.version = pkg.version;
  await writeFile(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
  await cp("src/popup/popup.html", `${outdir}/popup.html`);
  await cp("icons", `${outdir}/icons`, { recursive: true });
}

/** MV3 content scripts and the service worker are plain scripts: one IIFE per entry. */
const options = {
  entryPoints: [
    { in: "src/background/index.ts", out: "background" },
    { in: "src/content/index.ts", out: "content" },
    { in: "src/page/bridge.ts", out: "page-bridge" },
    { in: "src/page/trade-bridge.ts", out: "trade-bridge" },
    { in: "src/page/cm-play-bridge.ts", out: "cm-play-bridge" },
    { in: "src/popup/popup.ts", out: "popup" },
  ],
  outdir,
  bundle: true,
  format: "iife",
  target: ["chrome120"],
  platform: "browser",
  sourcemap: dev ? "inline" : false,
  minify: !dev,
  legalComments: "none",
  logLevel: "info",
  define: { __DEV__: String(dev) },
};

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  await copyStatic();
  console.log(`[build] watching -> ${outdir}/ (reload the extension after each change)`);
} else {
  await esbuild.build(options);
  await copyStatic();
  console.log(`[build] ${pkg.name} ${pkg.version} -> ${outdir}/`);
}
