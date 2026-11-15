// Turns a lit StandardMaterial into a "shadow catcher": the surface draws
// nothing but the darkening of the shadows that fall on it (plan decision L,
// from the spike). Used on one floor-sized plane for the character shadow
// light of the high rungs: a baked floor takes no live light, so a
// transparent catcher above it shows the characters' shadows. With no
// shadow its summed diffuse light equals the light's cosine on the floor
// (`litLevel`); alpha = (1 - diffuse / litLevel) * opacity.
import type { Material } from "@babylonjs/core/Materials/material";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Nullable } from "@babylonjs/core/types";

export class ShadowOnlyPlugin extends MaterialPluginBase {
	/** Diffuse light the catcher receives where nothing blocks the light (the light's cosine on the floor). */
	litLevel = 1;
	/** Darkness of a full shadow, 0 to 1. */
	opacity = 0.35;

	constructor(material: Material) {
		super(material, "ShadowOnly", 210, { SHADOW_ONLY: false });
		this._enable(true);
	}

	override isCompatible(shaderLanguage: ShaderLanguage): boolean {
		return shaderLanguage === ShaderLanguage.GLSL || shaderLanguage === ShaderLanguage.WGSL;
	}

	override getClassName(): string {
		return "ShadowOnlyPlugin";
	}

	override prepareDefines(defines: MaterialDefines): void {
		defines["SHADOW_ONLY"] = true;
	}

	override getUniforms(shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
		return {
			ubo: [{ name: "shadowOnly", size: 2, type: "vec2" }],
			fragment: shaderLanguage === ShaderLanguage.GLSL ? "#ifdef SHADOW_ONLY\nuniform vec2 shadowOnly;\n#endif" : "",
		};
	}

	override bindForSubMesh(uniformBuffer: UniformBuffer): void {
		uniformBuffer.updateFloat2("shadowOnly", Math.max(1e-3, this.litLevel), this.opacity);
	}

	override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): Nullable<Record<string, string>> {
		if (shaderType !== "fragment") return null;
		if (shaderLanguage === ShaderLanguage.WGSL) {
			return {
				CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `#ifdef SHADOW_ONLY
color = vec4f(0.0, 0.0, 0.0, clamp(1.0 - diffuseBase.r / uniforms.shadowOnly.x, 0.0, 1.0) * uniforms.shadowOnly.y);
#endif`,
			};
		}
		return {
			CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `#ifdef SHADOW_ONLY
color = vec4(0.0, 0.0, 0.0, clamp(1.0 - diffuseBase.r / shadowOnly.x, 0.0, 1.0) * shadowOnly.y);
#endif`,
		};
	}
}
