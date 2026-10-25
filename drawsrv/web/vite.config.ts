import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const packageRoot = resolve("node_modules/@excalidraw/excalidraw");
const { version } = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
);
const fontBase = `https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@${version}/dist/prod/`;

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
  ],
  server: { proxy: { "/api": "http://127.0.0.1:8080" } },
});
