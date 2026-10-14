// Build of the visual harness (test only): `vite build -c test/visual/vite.config.ts`
// then `vite preview -c test/visual/vite.config.ts`.
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [react()],
	worker: { format: "es" },
	optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
	build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
	preview: { port: 5174, strictPort: true },
});
