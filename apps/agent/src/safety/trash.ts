// Moves files to the operating system's trash, where the user can restore
// them; never deletes for good. macOS: NSFileManager's trashItemAtURL (the
// Finder's own "Move to Trash", run through osascript's JavaScript bridge,
// which needs no Finder automation permission). Windows: the Recycle Bin
// through Microsoft.VisualBasic's FileSystem. Linux: `gio trash`. Paths go
// as arguments or an environment variable, never inside a script.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const TIMEOUT_MS = 30_000;

/** Moves each path (a file or a folder) to the trash; throws when one did not go. */
export type Trash = (paths: readonly string[]) => Promise<void>;

/** The paths of the trash script; the rest of osascript's arguments. */
const MAC_SCRIPT = `function run(argv) {
  ObjC.import("Foundation");
  const fm = $.NSFileManager.defaultManager;
  const failed = [];
  for (const p of argv) {
    const error = Ref();
    if (!fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(p), null, error)) failed.push(p);
  }
  return failed.join("\\n");
}`;

const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName Microsoft.VisualBasic",
  "foreach ($p in ($env:TUNELO_TRASH | ConvertFrom-Json)) {",
  "  if (Test-Path -LiteralPath $p -PathType Container) {",
  "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  "  } else {",
  "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  "  }",
  "}",
].join("\n");

export function systemTrash(platform: NodeJS.Platform = process.platform): Trash {
  return async (paths) => {
    if (paths.length === 0) return;
    if (platform === "darwin") {
      const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT, ...paths], { timeout: TIMEOUT_MS });
      const failed = stdout.trim();
      if (failed) throw new Error(`the trash did not take: ${failed.split("\n").length} item(s)`);
      return;
    }
    if (platform === "win32") {
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], {
        timeout: TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, TUNELO_TRASH: JSON.stringify(paths) },
      });
      return;
    }
    await run("gio", ["trash", "--", ...paths], { timeout: TIMEOUT_MS }).catch((err: { code?: unknown }) => {
      // Servers often lack GLib's tools: say so rather than a bare spawn error.
      if (err.code === "ENOENT") throw new Error("moving to the trash needs `gio` (GLib, e.g. the libglib2.0-bin package), which this machine lacks", { cause: err });
      throw err;
    });
  };
}
