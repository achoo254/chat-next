// React for the app build and the test harness build, so render checks and
// perf runs measure the code that ships.
//
// React Compiler is wired but off by default; REACT_COMPILER=1 turns it on
// for a build or test run. Render reads no mutable state straight from the
// store or the pending backend any more (every read goes through a
// subscribing hook in services.tsx: useDialog, useListEntry, useUserNames,
// useBackendValue, ...), and the whole web test suite passes with the
// compiler on. What keeps it off is the startup bundle: with the compiler's
// output a signed-in start loads 166.8 KB gzip against the perf gate's
// 150 KB budget (148.5 KB without it; test/perf/budgets.ts).
// The lint rules of eslint-plugin-react-hooks (recommended-latest) already
// enforce what the compiler needs, so every component compiles today.
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import type { PluginOption } from "vite";

export function reactPlugins(): PluginOption[] {
	if (process.env.REACT_COMPILER !== "1") return [react()];
	return [react(), babel({ presets: [reactCompilerPreset()] })];
}
