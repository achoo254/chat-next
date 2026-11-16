// The terminal dock, loaded (with xterm and its styles) only when a terminal opens.
import { lazy } from "react";

export const TerminalScreen = lazy(() => import("../terminal/terminal-dock.tsx"));

/** The session header's path pill: its own small chunk (no xterm), shown on every view. */
export const SessionPathPill = lazy(() => import("../terminal/status-pill.tsx").then((m) => ({ default: m.SessionPathPill })));
