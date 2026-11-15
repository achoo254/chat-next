// Keeps Babylon off its CDN (the chat-next content policy only trusts its own
// origin): the meshopt decoder is served from public/decoders/babylon/, and
// every other address Babylon would build from its script base points at the
// same folder, so a missing helper fails with a 404 instead of loading from a
// third party. The decoder is its main-thread build: Babylon would start it
// in a blob: worker, which worker-src 'self' forbids (and the office's few MB
// decode fast on the main thread). WebP textures and meshopt only, no KTX2.
import { MeshoptCompression } from "@babylonjs/core/Meshes/Compression/meshoptCompression";
import { Tools } from "@babylonjs/core/Misc/tools";

const DECODER_BASE = `${import.meta.env.BASE_URL}decoders/babylon`;
let configured = false;

export function configureSelfHostedDecoders(): void {
	if (configured) return;
	configured = true;
	Tools.ScriptBaseUrl = DECODER_BASE;
	MeshoptCompression.Configuration = { decoder: { url: `${DECODER_BASE}/meshopt_decoder.main-thread.js` } };
}
