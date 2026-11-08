import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The local portal `tunelo http` serves; scripts/build-portal.ts builds it
// into dist/portal and embeds it in the release binary.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	root: resolve(__dirname, "src/tunnels/portal"),
	base: "/",
	build: {
		outDir: resolve(__dirname, "dist/portal"),
		emptyOutDir: true,
		rollupOptions: {
			input: resolve(__dirname, "src/tunnels/portal/index.html"),
		},
	},
});
