// `tunelo config capture-hotkey [shortcut|off]`: the global shortcut that
// opens tunelo-capture's overlay (ADR 0031). No argument shows it; "off"
// turns it off; "default" goes back to Ctrl+Alt+A (⌃⌥A on a Mac). The running
// service follows the change within a few seconds.
import type { Command } from "commander";
import { configDir } from "../config.ts";
import { DEFAULT_HOTKEY } from "../capture/capture-service.ts";
import { hotkeyOf, normalizeHotkey, readCaptureSettings, writeCaptureSettings } from "../capture/capture-settings.ts";

type Exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => (...args: A) => Promise<void>;

/** How a shortcut reads on this system ("⌃⌥A" on a Mac). */
export function shownHotkey(hotkey: string, platform: NodeJS.Platform = process.platform): string {
  if (hotkey === "") return "off";
  if (platform !== "darwin") return hotkey;
  const mac: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Super: "⌘" };
  return hotkey
    .split("+")
    .map((p) => mac[p] ?? p)
    .join("");
}

export function runCaptureHotkey(input: string | undefined, dir: string, print: (line: string) => void, printError: (line: string) => void): number {
  const settings = readCaptureSettings(dir);
  if (input === undefined) {
    print(`Screenshot shortcut: ${shownHotkey(hotkeyOf(settings))}`);
    return 0;
  }
  const value = input.trim().toLowerCase();
  const hotkey = value === "off" ? "" : value === "default" ? DEFAULT_HOTKEY : normalizeHotkey(input);
  if (hotkey === undefined) {
    printError(`"${input}" is not a shortcut: use one or more of Ctrl, Alt (Option), Shift, Cmd with a letter, a digit or F1-F24, as Ctrl+Alt+A.`);
    return 1;
  }
  writeCaptureSettings(dir, { ...settings, hotkey });
  print(`Screenshot shortcut: ${shownHotkey(hotkey)} (the running tunelo takes it within a few seconds)`);
  return 0;
}

export function registerCaptureHotkeyCommand(config: Command, exits: Exits): void {
  config
    .command("capture-hotkey [shortcut]")
    .description("the shortcut that opens the screenshot overlay, as Ctrl+Alt+A (default; ⌃⌥A on a Mac); off turns it off, default restores it; no shortcut shows it")
    .action(
      exits(async (shortcut: string | undefined) =>
        runCaptureHotkey(
          shortcut,
          configDir(),
          (l) => console.log(l),
          (l) => console.error(l),
        ),
      ),
    );
}
