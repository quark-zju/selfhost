import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const packageRoot = resolve("node_modules/@excalidraw/excalidraw");
const { version } = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
);
const fontBase = `https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@${version}/dist/prod/`;
const keptLanguages = new Set(["en", "zh-CN"]);

export default defineConfig({
  plugins: [
    react(),
    {
      name: "excalidraw-public-fonts",
      enforce: "pre",
      transformIndexHtml: (html) =>
        html.replace("__EXCALIDRAW_ASSET_BASE__", fontBase),
      transform(code, id) {
        if (!id.startsWith(packageRoot) || !id.endsWith(".css")) return;
        // UI fonts are CSS URLs; EXCALIDRAW_ASSET_PATH covers scene fonts only.
        return code.replace(
          /url\((["']?)(\.\/fonts\/[^)"']+)\1\)/g,
          (_match, _quote, path) => `url("${new URL(path, fontBase)}")`,
        );
      },
    },
    {
      name: "excalidraw-two-languages",
      enforce: "pre",
      resolveId(source, importer) {
        if (
          !importer?.startsWith(packageRoot) ||
          !source.startsWith("./locales/")
        )
          return;
        const match = /^\.\/locales\/(.+)-[A-Z0-9]+\.js$/.exec(source);
        if (!match || match[1] === "percentages" || keptLanguages.has(match[1]))
          return;
        // The package ships a dynamic import table for every translation. Map
        // unsupported entries to English so they produce no additional chunks.
        const locales = resolve(dirname(importer), "locales");
        const english = readdirSync(locales).find((name) =>
          /^en-[A-Z0-9]+\.js$/.test(name),
        );
        if (!english)
          throw new Error("Excalidraw English locale was not found");
        return resolve(locales, english);
      },
    },
  ],
  server: { proxy: { "/api": "http://127.0.0.1:8080" } },
});
