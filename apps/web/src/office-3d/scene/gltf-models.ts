// Finding the models in a loaded GLB that holds several (the floor props, the
// accessories): one named top-level node per model, under the glTF loader's
// root node; a model with several materials is a node with one child mesh per
// part, a model with one material is a single mesh.
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

/** The drawable parts of a model node: itself when it has geometry, plus its descendants with geometry. */
export function modelParts(node: TransformNode): Mesh[] {
	const all = [node, ...node.getChildMeshes(false)];
	return all.filter((m): m is Mesh => "createInstance" in m && "getTotalVertices" in m && (m as Mesh).getTotalVertices() > 0);
}

/** The container's models by top-level node name (children of the glTF root, or roots without one). */
export function containerModels(container: AssetContainer): Map<string, TransformNode> {
	const out = new Map<string, TransformNode>();
	for (const root of container.rootNodes) {
		const tops = root.name === "__root__" ? root.getChildren((n): n is TransformNode => n instanceof TransformNode, true) : root instanceof TransformNode ? [root] : [];
		for (const top of tops) if (!out.has(top.name)) out.set(top.name, top);
	}
	return out;
}
