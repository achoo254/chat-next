// The miniature look in post (from Chùa Nhỏ's post-processing.ts, tuned in
// the character and room spike): one DefaultRenderingPipeline with Khronos
// PBR Neutral tone mapping (keeps the honey wood of the concept; ACES turned
// it red), vignette, bloom, FXAA and the tilt-shift depth of field by quality
// rung, plus SSAO2 on the desktop rung only. Bloom's threshold sits above the
// brightest baked surface, so only lamps and glowing screens bloom.
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { DepthOfFieldEffectBlurLevel } from "@babylonjs/core/PostProcesses/depthOfFieldEffect";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { SSAO2RenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline";
import "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent";
import "@babylonjs/core/Rendering/depthRendererSceneComponent";
import "@babylonjs/core/Rendering/geometryBufferRendererSceneComponent";
import "@babylonjs/core/Rendering/prePassRendererSceneComponent";
// SSAO2 renders a geometry buffer into several targets at once; both engines need their multi-render extension.
import "@babylonjs/core/Engines/Extensions/engine.multiRender";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";
import type { Scene } from "@babylonjs/core/scene";
import type { QualityLevel } from "../engine/quality-levels.ts";

export interface PostProcessing {
	applyQuality(level: QualityLevel): void;
	/** Exposure and bloom of the hour (office-lighting.ts): night raises both, lamps and screens are the subject then. */
	applyLight(exposure: number, bloomWeight: number): void;
	setSsao(on: boolean): void;
	readonly ssaoOn: boolean;
	focusAt(distance: number): void;
	dispose(): void;
}

/** `neutral` (Khronos PBR Neutral) keeps the AI textures' colours; ACES darkens and saturates warm wood. */
export type ToneMapping = "aces" | "neutral";

export function createPostProcessing(scene: Scene, camera: Camera, toneMapping: ToneMapping = "neutral"): PostProcessing {
	const pipeline = new DefaultRenderingPipeline("office-look", true, scene, [camera]);
	pipeline.imageProcessingEnabled = true;
	const image = pipeline.imageProcessing;
	image.toneMappingEnabled = true;
	image.toneMappingType = toneMapping === "aces" ? ImageProcessingConfiguration.TONEMAPPING_ACES : ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
	image.exposure = 1.15;
	image.contrast = 1.08;
	image.vignetteEnabled = true;
	image.vignetteStretch = 0.4;
	image.vignetteWeight = 1.6;
	image.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
	image.vignetteColor = new Color4(0.17, 0.14, 0.25, 0);
	pipeline.bloomThreshold = 0.92;
	pipeline.bloomKernel = 48;
	pipeline.bloomScale = 0.5;
	pipeline.bloomWeight = 0.35;
	pipeline.depthOfField.focalLength = 110;
	pipeline.depthOfField.fStop = 2.8;
	pipeline.depthOfField.lensSize = 50;

	let ssao: SSAO2RenderingPipeline | null = null;
	const setSsao = (on: boolean): void => {
		if (on && !ssao) {
			ssao = new SSAO2RenderingPipeline("office-ssao", scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [camera], false);
			ssao.radius = 0.6;
			ssao.totalStrength = 1.1;
			ssao.samples = 12;
			ssao.maxZ = 60;
			ssao.expensiveBlur = false;
		} else if (!on && ssao) {
			ssao.dispose();
			ssao = null;
		}
	};

	return {
		applyQuality(level) {
			pipeline.fxaaEnabled = level.fxaa;
			pipeline.bloomEnabled = level.bloom;
			pipeline.depthOfFieldEnabled = level.depthOfField;
			pipeline.depthOfFieldBlurLevel = level.id === "ultra" ? DepthOfFieldEffectBlurLevel.Medium : DepthOfFieldEffectBlurLevel.Low;
			setSsao(level.ssao);
		},
		applyLight(exposure, bloomWeight) {
			pipeline.bloomWeight = bloomWeight;
			image.exposure = exposure;
		},
		setSsao,
		get ssaoOn() {
			return ssao !== null;
		},
		focusAt(distance) {
			// Babylon measures the focus distance in millimetres of scene units.
			pipeline.depthOfField.focusDistance = distance * 1000;
		},
		dispose() {
			setSsao(false);
			pipeline.dispose();
		},
	};
}
