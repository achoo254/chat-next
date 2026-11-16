// Day and night lightmaps blended by one uniform (plan decision K, proven on
// WebGPU and WebGL2 in the character and room spike): a material plugin on
// the StandardMaterial of every baked mesh. The mesh carries the lightmap UVs
// in its second UV set; the plugin samples both lightmaps there and
// multiplies the albedo by mix(day, night, nightMix) * scale, then adds
// albedo * glow for things that shine by themselves (screens, lamp shades).
// The baked meshes take no live light (disableLighting, white emissive): the
// lightmaps supply all of it, furniture shadows included. Both maps are
// sRGB-encoded like the albedo; `scale` undoes the half-intensity bake.
// `woodTone` calms the baked atlas's orange wood toward the concept's light
// brown: where the lit colour is warm orange (red over green over blue; the
// bake's warm light makes much of it) it loses some saturation, so lavender
// walls, rugs, plants and red art keep theirs.
// Shader code exists for GLSL (WebGL2) and WGSL (WebGPU).
import type { Material } from "@babylonjs/core/Materials/material";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Nullable } from "@babylonjs/core/types";

/** Gamma-space factor that undoes the half-intensity bake (2 in linear light). */
export const LIGHTMAP_HALF_BAKE_SCALE = Math.pow(2, 1 / 2.2);

const GLSL_VERTEX = {
	CUSTOM_VERTEX_DEFINITIONS: `#ifdef LIGHTMAP_BLEND
#ifndef UV2
attribute vec2 uv2;
#endif
varying vec2 vLightmapBlendUV;
#endif`,
	CUSTOM_VERTEX_MAIN_END: `#ifdef LIGHTMAP_BLEND
vLightmapBlendUV = uv2;
#endif`,
};

const GLSL_FRAGMENT = {
	CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef LIGHTMAP_BLEND
varying vec2 vLightmapBlendUV;
uniform sampler2D lightmapDaySampler;
uniform sampler2D lightmapNightSampler;
#endif`,
	CUSTOM_FRAGMENT_BEFORE_FOG: `#ifdef LIGHTMAP_BLEND
vec3 lightmapBlendDay = texture2D(lightmapDaySampler, vLightmapBlendUV).rgb;
vec3 lightmapBlendNight = texture2D(lightmapNightSampler, vLightmapBlendUV).rgb;
color.rgb *= mix(lightmapBlendDay, lightmapBlendNight, lightmapBlend.x) * lightmapBlend.y;
color.rgb += baseColor.rgb * lightmapBlend.z;
float lightmapWood = smoothstep(0.1, 0.35, color.r - color.b) * smoothstep(0.04, 0.16, color.g - color.b) * lightmapBlend.w;
color.rgb = mix(color.rgb, vec3(dot(color.rgb, vec3(0.299, 0.587, 0.114))), lightmapWood * 0.45);
#endif`,
};

const WGSL_VERTEX = {
	CUSTOM_VERTEX_DEFINITIONS: `#ifdef LIGHTMAP_BLEND
#ifndef UV2
attribute uv2: vec2f;
#endif
varying vLightmapBlendUV: vec2f;
#endif`,
	CUSTOM_VERTEX_MAIN_END: `#ifdef LIGHTMAP_BLEND
vertexOutputs.vLightmapBlendUV = vertexInputs.uv2;
#endif`,
};

const WGSL_FRAGMENT = {
	CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef LIGHTMAP_BLEND
varying vLightmapBlendUV: vec2f;
var lightmapDaySamplerSampler: sampler;
var lightmapDaySampler: texture_2d<f32>;
var lightmapNightSamplerSampler: sampler;
var lightmapNightSampler: texture_2d<f32>;
#endif`,
	CUSTOM_FRAGMENT_BEFORE_FOG: `#ifdef LIGHTMAP_BLEND
let lightmapBlendDay = textureSample(lightmapDaySampler, lightmapDaySamplerSampler, fragmentInputs.vLightmapBlendUV).rgb;
let lightmapBlendNight = textureSample(lightmapNightSampler, lightmapNightSamplerSampler, fragmentInputs.vLightmapBlendUV).rgb;
color = vec4f(color.rgb * mix(lightmapBlendDay, lightmapBlendNight, uniforms.lightmapBlend.x) * uniforms.lightmapBlend.y + baseColor.rgb * uniforms.lightmapBlend.z, color.a);
let lightmapWood = smoothstep(0.1, 0.35, color.r - color.b) * smoothstep(0.04, 0.16, color.g - color.b) * uniforms.lightmapBlend.w;
color = vec4f(mix(color.rgb, vec3f(dot(color.rgb, vec3f(0.299, 0.587, 0.114))), lightmapWood * 0.45), color.a);
#endif`,
};

export class LightmapBlendPlugin extends MaterialPluginBase {
	/** 0 = day lightmap, 1 = night lightmap. */
	nightMix = 0;
	scale = LIGHTMAP_HALF_BAKE_SCALE;
	/** Self-glow added after the lightmap (screens, lamp shades): albedo times this. */
	glow = 0;
	/** How far orange wood is calmed toward light brown (0 = the atlas as baked, 1 = full). */
	woodTone = 0;
	private readonly day: BaseTexture;
	private readonly night: BaseTexture;

	constructor(material: Material, day: BaseTexture, night: BaseTexture) {
		super(material, "LightmapBlend", 200, { LIGHTMAP_BLEND: false });
		this.day = day;
		this.night = night;
		this._enable(true);
	}

	/** Turns the blend off (albedo only) or back on; the material recompiles. */
	setEnabled(on: boolean): void {
		this._enable(on);
	}

	override isCompatible(shaderLanguage: ShaderLanguage): boolean {
		return shaderLanguage === ShaderLanguage.GLSL || shaderLanguage === ShaderLanguage.WGSL;
	}

	override getClassName(): string {
		return "LightmapBlendPlugin";
	}

	override prepareDefines(defines: MaterialDefines): void {
		defines["LIGHTMAP_BLEND"] = this.day.isReady() && this.night.isReady();
	}

	override isReadyForSubMesh(): boolean {
		return this.day.isReady() && this.night.isReady();
	}

	override getAttributes(attributes: string[]): void {
		// The standard material already lists uv2 when the mesh has it; a second entry is a WebGPU validation error
		// ("attribute shader location used more than once") that blanks every frame. WebGL2 ignores the duplicate.
		if (!attributes.includes("uv2")) attributes.push("uv2");
	}

	override getSamplers(samplers: string[]): void {
		samplers.push("lightmapDaySampler", "lightmapNightSampler");
	}

	override getUniforms(shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
		return {
			ubo: [{ name: "lightmapBlend", size: 4, type: "vec4" }],
			fragment: shaderLanguage === ShaderLanguage.GLSL ? "#ifdef LIGHTMAP_BLEND\nuniform vec4 lightmapBlend;\n#endif" : "",
		};
	}

	override bindForSubMesh(uniformBuffer: UniformBuffer): void {
		uniformBuffer.updateFloat4("lightmapBlend", this.nightMix, this.scale, this.glow, this.woodTone);
		uniformBuffer.setTexture("lightmapDaySampler", this.day);
		uniformBuffer.setTexture("lightmapNightSampler", this.night);
	}

	override getActiveTextures(activeTextures: BaseTexture[]): void {
		activeTextures.push(this.day, this.night);
	}

	override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): Nullable<Record<string, string>> {
		const wgsl = shaderLanguage === ShaderLanguage.WGSL;
		if (shaderType === "vertex") return wgsl ? WGSL_VERTEX : GLSL_VERTEX;
		return wgsl ? WGSL_FRAGMENT : GLSL_FRAGMENT;
	}
}
