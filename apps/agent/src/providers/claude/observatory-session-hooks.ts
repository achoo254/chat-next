// Observatory in the Claude sessions tunelo opens (providers/types.ts
// SessionObserver):
// - a session through the Agent SDK gets one more hook callback per observed
//   event, which hands the payload to Observatory's queue and returns `{}` at
//   once (Claude waits for every callback); an Advisor session only on the
//   events it hooks already, its records labelled internal;
// - a CLI in the terminal gets, in the same `--settings` it already takes, one
//   `async` hook group per event running `tunelo observatory hook <event>` in
//   exec form (no shell: the same argv under bash, PowerShell or none), added
//   after the groups already there. The callbacks miss SessionStart at
//   startup and SessionEnd at the end; the session's start and end are told
//   from the query's own messages instead (index.ts).
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { OBSERVED_HOOK_EVENTS, observatoryHookGroup } from "../../observatory/install/observatory-settings-markers.ts";
import type { SessionObserver } from "../types.ts";

type SdkHooks = NonNullable<Options["hooks"]>;
type SdkHookEvent = keyof SdkHooks;

/** The label of an Advisor session's records: kept out of every total. */
export const ADVISOR_LABEL = "advisor";

/** The events observed in a working session through the SDK. */
export const OBSERVED_SDK_EVENTS: readonly SdkHookEvent[] = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PermissionRequest",
  "PermissionDenied",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "InstructionsLoaded",
  "PreCompact",
  "PostCompact",
  "Notification",
];

/** The events observed in an Advisor session: those its own hooks run on, nothing more. */
export const OBSERVED_ADVISOR_EVENTS: readonly SdkHookEvent[] = ["PreToolUse", "UserPromptSubmit", "PostToolUse"];

/** The callback that hands a payload to Observatory and lets Claude go on at once. */
export function observeCallback(observer: SessionObserver, label: string | undefined): HookCallback {
  return async (input) => {
    observer.hookEvent(input.hook_event_name, input, label);
    return {};
  };
}

/** `hooks` with Observatory's callback added after the matchers already there, for each of `events`. */
export function withObservedHooks(hooks: SdkHooks, observer: SessionObserver | undefined, events: readonly SdkHookEvent[], label?: string): SdkHooks {
  if (!observer) return hooks;
  const observe = { hooks: [observeCallback(observer, label)] };
  const out: SdkHooks = { ...hooks };
  for (const event of events) out[event] = [...(hooks[event] ?? []), observe];
  return out;
}

/**
 * The start and end of an SDK session, told from the query's own messages
 * (the callbacks miss SessionStart at startup and SessionEnd at the end):
 * - the first session id seen starts with `source` (startup or resume), with
 *   the model of the init message when it is one;
 * - a new id within the same query is a /clear: SessionEnd(reason "clear")
 *   for the old id, SessionStart(source "clear") for the new one, as the CLI's
 *   own hooks pair them (the ingest joins the two);
 * - an id seen again (an init repeated every turn, a message of a turn) adds
 *   nothing; each id ends once, the last one with reason "other" when the
 *   query ends.
 */
export class ObservedSessionLifecycle {
  private current: string | undefined;
  private readonly started = new Set<string>();
  private readonly closed = new Set<string>();

  constructor(
    private readonly observer: SessionObserver,
    private readonly cwd: string,
    private readonly source: "startup" | "resume",
    private readonly label: string | undefined,
  ) {}

  /** A message of the session `sessionId`; `init` when it is the init message (its model and mode). */
  saw(sessionId: string, init?: { model: string; permission_mode: string }): void {
    // An empty id (a message before the session has one) is no session: never a /clear.
    if (sessionId === "" || sessionId === this.current || this.started.has(sessionId)) return;
    const previous = this.current;
    if (previous !== undefined) this.end(previous, "clear");
    this.current = sessionId;
    this.started.add(sessionId);
    this.observer.hookEvent(
      "SessionStart",
      { hook_event_name: "SessionStart", session_id: sessionId, cwd: this.cwd, source: previous === undefined ? this.source : "clear", ...(init ?? {}) },
      this.label,
    );
  }

  /** The query ended: the session last seen ends. */
  ended(): void {
    if (this.current !== undefined) this.end(this.current, "other");
  }

  private end(sessionId: string, reason: "clear" | "other"): void {
    if (this.closed.has(sessionId)) return;
    this.closed.add(sessionId);
    this.observer.hookEvent("SessionEnd", { hook_event_name: "SessionEnd", session_id: sessionId, cwd: this.cwd, reason }, this.label);
  }
}

/** CLI settings with hooks (`{ hooks: { Stop: [...] } }`), as --settings takes them. */
export type CliSettings = { hooks: Record<string, unknown[]>; env?: Record<string, string>; [key: string]: unknown };

/** `settings` with an Observatory hook group for every observed event, after the groups already there. */
export function withObservatoryHookGroups(settings: CliSettings, argv: readonly string[]): CliSettings {
  const hooks: Record<string, unknown[]> = { ...settings.hooks };
  for (const event of OBSERVED_HOOK_EVENTS) hooks[event] = [...(hooks[event] ?? []), observatoryHookGroup(argv, event)];
  return { ...settings, hooks };
}
