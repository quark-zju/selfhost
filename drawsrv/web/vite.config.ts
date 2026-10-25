import { cpSync, mkdirSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Excalidraw's default fonts otherwise come from a public CDN.
function fonts() {
  mkdirSync("public/fonts", { recursive: true });
  cpSync(
    "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
    "public/fonts",
    {
      recursive: true,
    },
  );
}
fonts();
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8080" } },
});
