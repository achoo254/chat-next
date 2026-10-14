// React for the app build and the test harness build, so render checks and
// perf runs measure the code that ships.
//
// React Compiler is wired but off by default; REACT_COMPILER=1 turns it on
// for a build or test run. Two things must hold before it becomes the
// default:
// - Render reads no mutable state straight from the store or the pending
//   backend (`backend.isMuted(id)`, `store.user(id)` after a hook that only
//   forces a re-render): the compiler memoizes those calls and the UI goes
//   stale. Five messaging tests fail with it on until every read goes
//   through a subscribing hook (useDialog, useUser, ... in services.tsx).
// - The startup bundle keeps the perf gate's 150 KB budget with the
//   compiler's output (about +19 KB gzip today; test/perf/budgets.ts).
// The lint rules of eslint-plugin-react-hooks (recommended-latest) already
// enforce what the compiler needs, so every component compiles today.
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import type { PluginOption } from "vite";

export function reactPlugins(): PluginOption[] {
	if (process.env.REACT_COMPILER !== "1") return [react()];
	return [react(), babel({ presets: [reactCompilerPreset()] })];
}
