// The terminal dock, loaded (with xterm and its styles) only when a terminal opens.
import { lazy } from "react";

export const TerminalScreen = lazy(() => import("../terminal/terminal-dock.tsx"));

/** The terminal's path pill, from the same chunk. */
export const TerminalPill = lazy(() => import("../terminal/terminal-dock.tsx").then((m) => ({ default: m.DockPill })));
