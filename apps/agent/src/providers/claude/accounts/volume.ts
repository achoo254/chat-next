// Links between a profile and the machine's Claude folder only work on one
// drive (Windows junctions and hard links); elsewhere tunelo keeps the
// profile's own copy instead.
import { statSync } from "node:fs";
import { parse, resolve } from "node:path";

/** True when both paths are on one drive (Windows) or one device (elsewhere). */
export function sameVolume(a: string, b: string): boolean {
  if (process.platform === "win32") return parse(resolve(a)).root.toLowerCase() === parse(resolve(b)).root.toLowerCase();
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}
