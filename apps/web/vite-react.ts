// React for the app build and the test harness build, so render checks and
// perf runs measure the code that ships.
//
// React Compiler is on: render reads no mutable state straight from the
// store or the pending backend (every read goes through a subscribing hook
// in services.tsx: useDialog, useListEntry, useUserNames, useBackendValue,
// ...), and the lint rules of eslint-plugin-react-hooks (recommended-latest)
// enforce what the compiler needs, so every component compiles. Its output
// adds about 18 KB gzip to a signed-in start (130.7 KB with it, 112.5 KB
// without, against the perf gate's 150 KB; test/perf/budgets.ts).
// REACT_COMPILER=0 builds or tests without it, to compare.
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import type { PluginOption } from "vite";

export function reactPlugins(): PluginOption[] {
	if (process.env.REACT_COMPILER === "0") return [react()];
	return [react(), babel({ presets: [reactCompilerPreset()] })];
}
