import * as esbuild from "esbuild";

/**
 * The console probe, bundled the same way the extension is. Kept out of `dist/`
 * on purpose: it is a measuring tool, not something to ship to a browser.
 */
await esbuild.build({
  entryPoints: [
    { in: "tools/probe-market.ts", out: "market" },
    { in: "tools/probe-book.ts", out: "book" },
    { in: "tools/probe-history.ts", out: "history" },
  ],
  outdir: ".probe",
  bundle: true,
  format: "iife",
  target: ["chrome120"],
  platform: "browser",
  logLevel: "info",
  define: { __DEV__: "false" },
});
console.log(
  "[probe] .probe/market.js (что видит на странице), .probe/book.js (какой эндпоинт отвечает)," +
    " .probe/history.js (как размечена история продаж)"
);
