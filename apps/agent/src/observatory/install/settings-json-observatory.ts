// Observatory's entries in a Claude Code settings.json, as text edits that
// touch nothing else (json-text-edit.ts); what the entries are and how they
// are recognised is observatory-settings-markers.ts. Adding twice changes
// nothing; removing takes out exactly what adding put in, and a container
// only when the install's record says it made it, so the rest of the file
// keeps its bytes. Used by the install only.
import { type JsonLayout, type JsonNode, appendElement, appendMember, layoutOf, memberOf, readJsonSpans, removeItem, replaceValue, valueOf } from "./json-text-edit.ts";
import {
  type HookGroup,
  OBSERVED_HOOK_EVENTS,
  TUNELO_OBSERVATORY_ENV_MARKER,
  TUNELO_OBSERVATORY_MARKER_VALUE,
  isObservatoryHookGroup,
  observatoryEnvKeys,
  observatoryHookGroup,
  parseSettings,
} from "./observatory-settings-markers.ts";

const BOM = "\uFEFF";

/** Runs `edit` on the text without its byte-order mark, then puts the mark back. */
function keepingBom(text: string, edit: (body: string) => string): string {
  const bom = text.startsWith(BOM) ? BOM : "";
  return bom + edit(text.slice(bom.length));
}

function rootOf(text: string): JsonNode {
  const root = readJsonSpans(text);
  if (root.kind !== "object") throw new Error("settings.json does not hold a JSON object");
  return root;
}

/** A container of settings.json by its member keys from the root (`["hooks", "Stop"]`, `["env"]`). */
export type ContainerPath = readonly string[];

/** Two container paths name the same container. */
export const samePath = (a: ContainerPath, b: ContainerPath): boolean => a.length === b.length && a.every((k, i) => k === b[i]);

/** One hook event's groups: Observatory's replaced by `group`, the user's left in place. Containers it makes go to `created`. */
function withHookGroup(text: string, event: string, group: HookGroup, layout: JsonLayout, created: ContainerPath[]): string {
  let root = rootOf(text);
  const hooks = memberOf(root, "hooks");
  if (!hooks) {
    created.push(["hooks"], ["hooks", event]);
    return appendMember(text, root, "hooks", { [event]: [group] }, 1, layout);
  }
  if (hooks.value.kind !== "object") throw new Error("settings.json has `hooks` that is not an object");
  const list = memberOf(hooks.value, event);
  if (!list) {
    created.push(["hooks", event]);
    return appendMember(text, hooks.value, event, [group], 2, layout);
  }
  if (list.value.kind !== "array") throw new Error(`settings.json has hooks.${event} that is not a list`);
  const same = list.value.elements.filter((e) => isObservatoryHookGroup(valueOf(text, e)));
  if (same.length === 1 && same[0] && JSON.stringify(valueOf(text, same[0])) === JSON.stringify(group)) return text;
  // A group of an earlier install (another path to tunelo): taken out, then the current one added.
  let out = text;
  for (;;) {
    root = rootOf(out);
    const arr = memberOf(memberOf(root, "hooks")?.value, event)?.value;
    if (arr?.kind !== "array") break;
    const at = arr.elements.findIndex((e) => isObservatoryHookGroup(valueOf(out, e)));
    if (at < 0) return appendElement(out, arr, group, 3, layout);
    out = removeItem(out, arr, at, 3, layout);
  }
  return out;
}

function withEnv(text: string, env: Record<string, string>, layout: JsonLayout, created: ContainerPath[]): string {
  const wanted: Record<string, string> = { ...env, [TUNELO_OBSERVATORY_ENV_MARKER]: TUNELO_OBSERVATORY_MARKER_VALUE };
  let out = text;
  const root = rootOf(out);
  if (!memberOf(root, "env")) {
    created.push(["env"]);
    return appendMember(out, root, "env", wanted, 1, layout);
  }
  for (const [key, value] of Object.entries(wanted)) {
    const envNode = memberOf(rootOf(out), "env")?.value;
    if (envNode?.kind !== "object") throw new Error("settings.json has `env` that is not an object");
    const current = memberOf(envNode, key);
    if (!current) out = appendMember(out, envNode, key, value, 2, layout);
    else if (valueOf(out, current.value) !== value) out = replaceValue(out, current.value, value, 2, layout);
  }
  return out;
}

/**
 * What an install made in a file, for its uninstall: the containers that did
 * not exist before, and the indentation it wrote with (the file's own; read
 * again later it could look deeper, once only Observatory's lines are indented).
 */
export type InstallRecord = { created: readonly ContainerPath[]; indent: string };

/** The file's layout, with the indentation an earlier install recorded when there is one. */
function layoutWith(body: string, indent: string | undefined): JsonLayout {
  const layout = layoutOf(body);
  return indent === undefined ? layout : { ...layout, unit: indent };
}

/**
 * `text` (a settings.json, maybe empty) with Observatory's hook groups for
 * `argv` and, when given, its OTel `env`; `created` lists the containers
 * (`hooks`, `hooks.<event>`, `env`) that did not exist before, which only an
 * uninstall may take out again. `indent`: the one an earlier install recorded.
 */
export function addObservatory(
  text: string,
  argv: readonly string[],
  env: Record<string, string> | undefined,
  indent?: string,
): { text: string; created: ContainerPath[]; indent: string } {
  const created: ContainerPath[] = [];
  let unit = indent ?? "  ";
  const out = keepingBom(text.trim() === "" ? "{}\n" : text, (body) => {
    const layout = layoutWith(body, indent);
    unit = layout.unit;
    let next = body;
    for (const event of OBSERVED_HOOK_EVENTS) next = withHookGroup(next, event, observatoryHookGroup(argv, event), layout, created);
    return env ? withEnv(next, env, layout, created) : next;
  });
  return { text: out, created, indent: unit };
}

/** addObservatory's text alone. */
export function withObservatory(text: string, argv: readonly string[], env: Record<string, string> | undefined): string {
  return addObservatory(text, argv, env).text;
}

/** `text` with Observatory's OTel keys set to `env` (a new token), when it holds them; the same text otherwise. */
export function withRefreshedObservatoryEnv(text: string, env: Record<string, string>): string {
  const settings = parseSettings(text);
  if (!settings || observatoryEnvKeys(settings.env).length === 0) return text;
  return keepingBom(text, (body) => withEnv(body, env, layoutOf(body), []));
}

const nodeAt = (text: string, path: ContainerPath): JsonNode | undefined => path.reduce<JsonNode | undefined>((n, key) => memberOf(n, key)?.value, rootOf(text));

/**
 * The container at `path` exists in `text` and holds Observatory's entries
 * only (an event list of its groups, a `hooks` of such lists, an `env` of its
 * keys): an earlier install's record of it still holds. One the user emptied
 * or filled since does not.
 */
export function stillOnlyObservatory(text: string, path: ContainerPath): boolean {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  if (body.trim() === "") return false;
  const node = nodeAt(body, path);
  if (!node) return false;
  const value = valueOf(body, node);
  const groupsOnly = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.every(isObservatoryHookGroup);
  if (path.length === 2 && path[0] === "hooks") return groupsOnly(value);
  if (path.length === 1 && path[0] === "hooks") return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0 && Object.values(value).every(groupsOnly);
  if (path.length === 1 && path[0] === "env") {
    const ours = new Set([...observatoryEnvKeys(value), TUNELO_OBSERVATORY_ENV_MARKER]);
    return typeof value === "object" && value !== null && Object.keys(value).length > 0 && Object.keys(value).every((k) => ours.has(k));
  }
  return false;
}

/** The members of `hooks`, `env` and the root that appear more than once (Claude Code reads the last; an edit would change the first). */
export function duplicateKeys(text: string): string[] {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  if (body.trim() === "") return [];
  const root = rootOf(body);
  const dupes = (node: JsonNode | undefined, prefix: string): string[] => {
    if (node?.kind !== "object") return [];
    const seen = new Set<string>();
    const out = new Set<string>();
    for (const m of node.members) (seen.has(m.key) ? out : seen).add(m.key);
    return [...out].map((k) => `${prefix}${k}`);
  };
  return [...dupes(root, ""), ...dupes(memberOf(root, "hooks")?.value, "hooks."), ...dupes(memberOf(root, "env")?.value, "env.")];
}

const isEmpty = (node: JsonNode | undefined): boolean => (node?.kind === "object" ? node.members.length === 0 : node?.kind === "array" ? node.elements.length === 0 : false);

/** Takes the member at `path` out of its parent object (`path` names a member, so it has at least one key). */
function withoutMember(text: string, path: ContainerPath, layout: JsonLayout): string {
  const parent = nodeAt(text, path.slice(0, -1));
  const key = path.at(-1);
  if (parent?.kind !== "object" || key === undefined) return text;
  const at = parent.members.findIndex((m) => m.key === key);
  return at < 0 ? text : removeItem(text, parent, at, path.length, layout);
}

/**
 * Removes the items `isOurs` picks from the container at `path`; when that
 * leaves it empty and `mayDrop` says the install made it, the container goes too.
 */
function withoutItems(
  text: string,
  path: ContainerPath,
  layout: JsonLayout,
  mayDrop: (path: ContainerPath) => boolean,
  isOurs: (text: string, node: JsonNode, key: string | undefined) => boolean,
): string {
  let out = text;
  let removed = false;
  for (;;) {
    const node = nodeAt(out, path);
    if (!node || (node.kind !== "object" && node.kind !== "array")) return out;
    const keys = node.kind === "object" ? node.members.map((m) => m.key) : node.elements.map(() => undefined);
    const nodes = node.kind === "object" ? node.members.map((m) => m.value) : node.elements;
    const at = nodes.findIndex((n, i) => isOurs(out, n, keys[i]));
    if (at < 0) break;
    out = removeItem(out, node, at, path.length + 1, layout);
    removed = true;
  }
  return removed && isEmpty(nodeAt(out, path)) && mayDrop(path) ? withoutMember(out, path, layout) : out;
}

/**
 * `text` without Observatory's hook groups and OTel keys; the same text when
 * it holds none. A container left empty goes only when the install's record
 * says it made it (install-state-file.ts); without a record every container
 * stays, even empty: one the install cannot prove it made may be the user's.
 */
export function withoutObservatory(text: string, record?: InstallRecord): string {
  if (text.trim() === "") return text;
  const mayDrop = (path: ContainerPath): boolean => record !== undefined && record.created.some((c) => samePath(c, path));
  return keepingBom(text, (body) => {
    const layout = layoutWith(body, record?.indent);
    let out = body;
    const hooks = memberOf(rootOf(out), "hooks")?.value;
    const events = hooks?.kind === "object" ? hooks.members.map((m) => m.key) : [];
    for (const event of events) out = withoutItems(out, ["hooks", event], layout, mayDrop, (t, n) => isObservatoryHookGroup(valueOf(t, n)));
    // `hooks` left empty by that goes too, when the install made it.
    if (out !== body && isEmpty(nodeAt(out, ["hooks"])) && mayDrop(["hooks"])) out = withoutMember(out, ["hooks"], layout);
    const env = memberOf(rootOf(out), "env")?.value;
    const ours = new Set(env ? observatoryEnvKeys(valueOf(out, env)) : []);
    if (ours.size > 0) {
      ours.add(TUNELO_OBSERVATORY_ENV_MARKER);
      out = withoutItems(out, ["env"], layout, mayDrop, (_t, _n, key) => key !== undefined && ours.has(key));
    }
    return out;
  });
}
