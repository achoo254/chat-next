// Address switches of the 3D office, for testing and measuring on devices:
//   office3d=off      always the 2D view
//   office3d=force    3D even on a software renderer (SwiftShader in CI)
//   office3d-backend=webgl2   skip WebGPU
//   office3d-quality=low|medium|high|ultra   pin a rung (no automatic scaler)
//   office3d-test     expose window.__office (draw calls, frames, people)
// The same switches can sit in localStorage under FLAGS_KEY (as a query
// string), for a phone or a test page whose address the app rewrites.
// And the check that decides 3D or 2D before any 3D code loads: a hardware
// WebGL2 context (failIfMajorPerformanceCaveat), not a software renderer.
import type { RendererPreference } from "./engine/create-render-engine.ts";

export interface Office3DFlags {
	readonly mode: "auto" | "force" | "off";
	readonly preference: RendererPreference;
	readonly quality: string | null;
	readonly testApi: boolean;
}

export const FLAGS_KEY = "ai:office:3d-flags";

function storedFlags(): string {
	try {
		return window.localStorage.getItem(FLAGS_KEY) ?? "";
	} catch {
		return "";
	}
}

/** Switches from the address, else from localStorage. */
export function office3DFlags(search: string, stored: string = storedFlags()): Office3DFlags {
	const own = new URLSearchParams(search);
	const params = [...own.keys()].some((k) => k.startsWith("office3d")) ? own : new URLSearchParams(stored);
	const mode = params.get("office3d");
	return {
		mode: mode === "off" ? "off" : mode === "force" ? "force" : "auto",
		preference: params.get("office3d-backend") === "webgl2" ? "webgl2" : "auto",
		quality: params.get("office3d-quality"),
		testApi: params.has("office3d-test"),
	};
}

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/** Whether this device can draw the 3D office well; false sends it to the 2D view. */
export function hardware3DAvailable(flags: Office3DFlags): boolean {
	if (flags.mode === "off") return false;
	if (typeof document === "undefined") return false;
	try {
		const probe = document.createElement("canvas");
		const gl = probe.getContext("webgl2", { failIfMajorPerformanceCaveat: flags.mode !== "force" });
		if (gl === null) return false;
		let software = false;
		if (flags.mode !== "force") {
			const info = gl.getExtension("WEBGL_debug_renderer_info");
			const renderer = info === null ? "" : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
			software = SOFTWARE_RENDERER.test(renderer);
		}
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		return !software;
	} catch {
		return false;
	}
}
