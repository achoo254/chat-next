export * from "./entities/index.ts";
export * from "./ids/index.ts";
export * from "./vifold/index.ts";
export * from "./model/types.ts";
export { EventBus, EventKeys, type BatchListener, type KeyListener } from "./events/bus.ts";
export { createRemoteApi, classifyFailure, SessionEndedError, type FailureKind, type RemoteApi } from "./protocol/api.ts";
export { fromWireEntity, toMediaRef } from "./protocol/map.ts";
export { MIGRATIONS, SCHEMA_VERSION, migrate, type Migration, type MigrationOutcome } from "./repo/migrations.ts";
export { Repository, type DialogView, type OutboxRow, type StoredMessage } from "./repo/repository.ts";
export {
	ftsQuery,
	hasFilters,
	matchesSubstrings,
	searchLocal,
	SUBSTRING_MIN_CHARS,
	textMatch,
	type SearchOptions,
	type TextMatch,
} from "./search/index.ts";
export { hitKey, mergeSearchHits, sortNewestFirst, type HitSource, type SearchHit, type ServerHits } from "./search/merge.ts";
export { fetchServerSearch, SERVER_PAGE, type ServerSearchPage, type ServerSearchRequest } from "./search/server.ts";
export {
	IDLE_SEARCH,
	isSearchable,
	SearchSession,
	SERVER_DEBOUNCE_MS,
	type SearchRequest,
	type SearchSessionOptions,
	type SearchSessionTimers,
	type SearchState,
	type ServerSearchResult,
	type ServerSearchStatus,
} from "./search/session.ts";
export { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from "./transport/backoff.ts";
export {
	RealtimeConnection,
	deadAfterMs,
	REALTIME_PATH,
	realtimeUrlFor,
	type ConnectionState,
	type RealtimeHandlers,
	type RealtimeOptions,
} from "./transport/realtime.ts";
export { SyncEngine, type HistoryDirectionName, type SyncEngineOptions } from "./sync/engine.ts";
export {
	Outbox,
	OutboxError,
	parseOperation,
	type AlbumItemInput,
	type MediaInput,
	type OutboxOperation,
	type PendingMedia,
	type PendingMessage,
	type SendAlbumOptions,
	type SendMediaOptions,
	type SendTextOptions,
} from "./outbox/outbox.ts";
export { decodeMediaRef, encodeMediaRef, fromBase64, toBase64 } from "./media/codec.ts";
export { Sha256, sha256Blob } from "./media/sha256.ts";
export { DEFAULT_MEDIA_LIMITS, type MediaLimits } from "./media/limits.ts";
export { cacheKey, LARGE_FILE_BYTES, MediaCache, type CacheLimits } from "./media/media-cache.ts";
export { MediaLoader, URLS_PER_CALL, type MediaFile, type MediaRequest, type MediaUrl } from "./media/media-loader.ts";
export {
	AdaptiveConcurrency,
	DEFAULT_CONCURRENCY,
	UploadQueue,
	type ConcurrencyPolicy,
	type UploadProgress,
	type UploadSpec,
	type UploadState,
} from "./media/upload-queue.ts";
export { buildSnapshot, parseSnapshot, SNAPSHOT_VERSION, type ScreenSnapshot, type SnapshotDialog } from "./snapshot/snapshot.ts";
export { databaseName, isReturnPath, signInUrl, SIGN_OUT_PATH, type SessionEndReason } from "./auth/web.ts";
export { DirectActions, UnsupportedApiError, type PinnedMessagesRequest } from "./app/direct-actions.ts";
export { TYPING_REPEAT_MS, TYPING_SHOWN_MS } from "./app/typing.ts";
export {
	startApp,
	type ChatCore,
	type ClientKind,
	type HistoryRequest,
	type HistoryView,
	type StartOptions,
	type StartResult,
} from "./app/start-app.ts";
