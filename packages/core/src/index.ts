export * from "./entities/index.ts";
export * from "./ids/index.ts";
export * from "./vifold/index.ts";
export * from "./model/types.ts";
export { EventBus, EventKeys, type BatchListener, type KeyListener } from "./events/bus.ts";
export { createRemoteApi, classifyFailure, SessionEndedError, type FailureKind, type RemoteApi } from "./protocol/api.ts";
export { MIGRATIONS, SCHEMA_VERSION, migrate, type Migration, type MigrationOutcome } from "./repo/migrations.ts";
export { Repository, type DialogView, type OutboxRow, type StoredMessage } from "./repo/repository.ts";
export { ftsQuery, searchLocal, type SearchOptions } from "./search/index.ts";
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
	type OutboxOperation,
	type PendingMessage,
	type SendTextOptions,
} from "./outbox/outbox.ts";
export { buildSnapshot, parseSnapshot, SNAPSHOT_VERSION, type ScreenSnapshot, type SnapshotDialog } from "./snapshot/snapshot.ts";
export { databaseName, isReturnPath, signInUrl, SIGN_OUT_PATH, type SessionEndReason } from "./auth/web.ts";
export { DirectActions, UnsupportedApiError, type PinnedMessagesRequest } from "./app/direct-actions.ts";
export {
	startApp,
	type ChatCore,
	type ClientKind,
	type HistoryRequest,
	type HistoryView,
	type StartOptions,
	type StartResult,
} from "./app/start-app.ts";
