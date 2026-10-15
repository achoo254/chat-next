// Media limits issued by the server (AppConfig), with the stage 1 defaults
// while the config cannot be fetched.
import type { RemoteApi } from "../protocol/api.ts";
import type { CacheLimits } from "./media-cache.ts";

export interface MediaLimits {
	/** Largest file to upload; 0 = media disabled on the server (hide attaching). */
	readonly uploadSizeMax: number;
	readonly albumSizeMax: number;
	/** Caption length in code points. */
	readonly captionLengthMax: number;
	readonly cache: CacheLimits;
	/** False until AppConfig was fetched; the values are defaults then. */
	readonly fromServer: boolean;
}

const GIB = 2 ** 30;

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
	uploadSizeMax: 2000 * 2 ** 20,
	albumSizeMax: 10,
	captionLengthMax: 1024,
	cache: { sizeBytes: 2 * GIB, largeBytes: GIB, maxAgeMs: 30 * 24 * 3600 * 1000 },
	fromServer: false,
};

/** Holds the current limits and refreshes them from GetAppConfig. */
export class MediaLimitsSource {
	private value: MediaLimits = DEFAULT_MEDIA_LIMITS;
	private hash = "";
	private loading: Promise<MediaLimits> | null = null;

	constructor(private readonly api: RemoteApi["config"]) {}

	get current(): MediaLimits {
		return this.value;
	}

	/** Fetches the config (once at a time); keeps the previous values when it fails. */
	async load(): Promise<MediaLimits> {
		if (this.api === undefined) return this.value;
		this.loading ??= (async () => {
			try {
				const response = await this.api?.getAppConfig({ hash: this.hash });
				if (response?.result.case === "config") {
					const c = response.result.value;
					this.hash = c.hash;
					this.value = {
						uploadSizeMax: Number(c.uploadSizeMaxBytes),
						albumSizeMax: c.albumSizeMax > 0 ? c.albumSizeMax : DEFAULT_MEDIA_LIMITS.albumSizeMax,
						captionLengthMax: c.captionLengthMax > 0 ? c.captionLengthMax : DEFAULT_MEDIA_LIMITS.captionLengthMax,
						cache: {
							sizeBytes: c.mediaCacheSizeBytes > 0n ? Number(c.mediaCacheSizeBytes) : DEFAULT_MEDIA_LIMITS.cache.sizeBytes,
							largeBytes:
								c.mediaCacheLargeFilesBytes > 0n ? Number(c.mediaCacheLargeFilesBytes) : DEFAULT_MEDIA_LIMITS.cache.largeBytes,
							maxAgeMs:
								c.mediaCacheMaxAgeSeconds > 0 ? c.mediaCacheMaxAgeSeconds * 1000 : DEFAULT_MEDIA_LIMITS.cache.maxAgeMs,
						},
						fromServer: true,
					};
				}
				return this.value;
			} finally {
				this.loading = null;
			}
		})();
		return this.loading;
	}
}
