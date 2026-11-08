import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	root: resolve(__dirname, "src/portal"),
	base: "/",
	build: {
		outDir: resolve(__dirname, "portal-dist"),
		emptyOutDir: true,
		rollupOptions: {
			input: resolve(__dirname, "src/portal/index.html"),
		},
	},
});
