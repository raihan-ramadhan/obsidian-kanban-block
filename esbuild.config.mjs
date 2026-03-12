import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

// Build JS
const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await context.rebuild();

  // Minify styles.src.css → styles.css for release
  await esbuild.build({
    entryPoints: ["styles.src.css"],
    outfile: "styles.css",
    allowOverwrite: true,
    minify: true,
    logLevel: "info",
  });

  process.exit(0);
} else {
  // Dev: copy styles.src.css → styles.css as-is (readable)
  const { copyFileSync } = await import("fs");
  copyFileSync("styles.src.css", "styles.css");

  await context.watch();
}
