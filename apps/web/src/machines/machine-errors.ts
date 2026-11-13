// What to tell the user about a request the machine refused, in the account's
// language. Machines from tunelo 2.0.1 send a stable reason (and the one
// variable part it names); older machines, or a reason this page does not know
// yet, fall back to the error class, then to the machine's own English.
import { ErrorCode, ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { OfflineError, RemoteError } from "./link/machine-link.ts";
import type { MachinesCopy } from "./copy-vi.ts";

type Reasons = MachinesCopy["errors"]["reasons"];

/** Keychain kinds the machine names when it could not switch an AI's sign-in. */
const KEYCHAIN_SUBJECTS = new Set(["too-long", "failed", "keychain"]);

/**
 * Why an AI's account could not switch, by what holds it (ErrorReason.ACCOUNT_SWITCH_BLOCKED's
 * subject): a running process ("<cli> pid N"), the machine's locked Keychain, the Keychain
 * refusing, a session's title, or nothing named.
 */
function switchBlocked(r: Reasons, ai: string, subject: string): string {
	const b = r.accountSwitchBlocked;
	if (subject === "") return b.running(ai);
	const pid = /^\S+ pid (\d+)$/.exec(subject);
	if (pid !== null) return b.process(ai, pid[1] ?? "");
	if (subject === "locked") return b.locked(ai);
	if (KEYCHAIN_SUBJECTS.has(subject)) return b.keychain(ai);
	return b.session(ai, subject);
}

/** The sentence for a reason; undefined when this page does not know it. */
function reasonText(r: Reasons, err: RemoteError, ai: string): string | undefined {
	const s = err.subject;
	switch (err.reason) {
		case ErrorReason.FOLDER_NOT_FOUND:
			return r.folderNotFound;
		case ErrorReason.EMPTY_MESSAGE:
			return r.emptyMessage;
		case ErrorReason.SENSITIVE_FOLDER:
			return r.sensitiveFolder(s);
		case ErrorReason.PROJECT_SETTINGS_UNTRUSTED:
			return r.projectSettingsUntrusted(s);
		case ErrorReason.TRUST_ON_MACHINE:
			return r.trustOnMachine(s);
		case ErrorReason.AI_NOT_INSTALLED:
			return r.aiNotInstalled(s || ai);
		case ErrorReason.AI_NEEDS_LOGIN:
			return r.aiNeedsLogin(s || ai);
		case ErrorReason.UNKNOWN_AI:
			return r.unknownAi(s);
		case ErrorReason.SAME_AI:
			return r.sameAi;
		case ErrorReason.AI_START_FAILED:
			return r.aiStartFailed(ai, s);
		case ErrorReason.ACCOUNT_UNUSABLE:
			return r.profileUnusable(ai, s);
		case ErrorReason.THREAD_NOT_FOUND:
			return r.threadNotFound;
		case ErrorReason.ITEM_NOT_FOUND:
			return r.itemNotFound;
		case ErrorReason.PROMPT_STALE:
			return r.promptStale;
		case ErrorReason.DENY_MESSAGE_INVALID:
			return r.denyMessageInvalid;
		case ErrorReason.UNKNOWN_EFFORT:
			return r.unknownEffort(s);
		case ErrorReason.PERMISSION_MODE_NOT_ALLOWED:
			return r.permissionModeNotAllowed(s);
		case ErrorReason.NO_ACCOUNTS:
			return r.noProfiles(ai);
		case ErrorReason.ACCOUNT_NOT_FOUND:
			return r.profileNotFound(ai);
		case ErrorReason.DEFAULT_ACCOUNT_PERMANENT:
			return r.defaultProfilePermanent;
		case ErrorReason.ACCOUNT_IN_USE:
			return r.profileInUse;
		case ErrorReason.ACCOUNT_SIGN_OUT_FAILED:
			return r.profileSignOutFailed(ai);
		case ErrorReason.ACCOUNTS_DAMAGED:
			return r.profilesDamaged(ai);
		case ErrorReason.ACCOUNT_SWITCH_BLOCKED:
			return switchBlocked(r, ai, s);
		case ErrorReason.PROVIDER_REQUIRED:
			return r.providerRequired;
		case ErrorReason.AI_CLI_MISSING:
			return r.aiCliMissing(ai);
		case ErrorReason.NO_LOCAL_FORWARD:
			return r.noLocalForward;
		case ErrorReason.UNSUPPORTED_REQUEST:
			return r.unsupportedRequest;
		case ErrorReason.ACCESS_DENIED:
			return r.accessDenied;
		case ErrorReason.PATH_OUTSIDE_FOLDER:
			return r.pathOutsideFolder;
		case ErrorReason.FULL_DISK_ACCESS_NEEDED:
			return r.fullDiskAccessNeeded;
		case ErrorReason.SESSION_NOT_FOUND:
			return r.sessionNotFound;
		case ErrorReason.SESSION_OPEN_ELSEWHERE:
			return r.sessionOpenElsewhere;
		case ErrorReason.ATTACHMENT_TOO_LARGE:
			return r.attachmentTooLarge(s);
		case ErrorReason.TOO_MANY_ATTACHMENTS:
			return r.tooManyAttachments;
		case ErrorReason.ATTACHMENT_NOT_FOUND:
			return r.attachmentNotFound;
		case ErrorReason.THREAD_RUNNING:
			return r.threadRunning;
		case ErrorReason.TRASH_UNAVAILABLE:
			return r.trashUnavailable(s);
		case ErrorReason.PROJECT_NOT_FOUND:
			return r.projectNotFound;
		case ErrorReason.PROJECT_EXISTS:
			return r.projectExists(s);
		case ErrorReason.CLONE_URL_INVALID:
			return r.cloneUrlInvalid;
		case ErrorReason.CLONE_FAILED:
			return r.cloneFailed(s);
		case ErrorReason.GIT_NOT_INSTALLED:
			return r.gitNotInstalled;
		case ErrorReason.NAME_INVALID:
			return r.nameInvalid;
		case ErrorReason.SECRET_PROMPT_GONE:
			return r.secretPromptGone;
		case ErrorReason.SECRET_INVALID:
			return r.secretInvalid;
		case ErrorReason.SECRET_NOT_FOUND:
			return r.secretNotFound;
		case ErrorReason.BROWSER_UNAVAILABLE:
			return r.browserUnavailable;
		case ErrorReason.TAKEOVER_GONE:
			return r.takeoverGone;
		case ErrorReason.BROWSER_NOT_RUNNING:
			return r.browserNotRunning(ai);
		case ErrorReason.SCREEN_SHARING_OFF:
			return r.screenSharingOff;
		case ErrorReason.SCREEN_SHARE_BUSY:
			return r.screenShareBusy;
		case ErrorReason.SCREEN_SHARE_GONE:
			return r.screenShareGone;
		case ErrorReason.UPDATE_UNAVAILABLE:
			return r.updateUnavailable;
		case ErrorReason.UPDATE_BUSY:
			return r.updateBusy;
		case ErrorReason.TERMINAL_UNAVAILABLE:
			return r.terminalUnavailable;
		case ErrorReason.TERMINAL_SESSION_LIMIT:
			return r.terminalSessionLimit;
		case ErrorReason.TERMINAL_SESSION_NOT_FOUND:
			return r.terminalSessionNotFound;
		case ErrorReason.SECRET_FILE:
			return r.secretFile;
		case ErrorReason.GIT_UNSAFE_CONFIG:
			return r.gitUnsafeConfig(s);
		case ErrorReason.GIT_NEEDS_CREDENTIALS:
			return r.gitNeedsCredentials;
		case ErrorReason.GIT_FAILED:
			return r.gitFailed(s);
		case ErrorReason.GIT_BUSY:
			return r.gitBusy;
		case ErrorReason.NOT_A_GIT_REPOSITORY:
			return r.notGitRepository;
		case ErrorReason.DISCARD_NOT_CONFIRMED:
			return r.discardNotConfirmed;
		case ErrorReason.FOLDER_TOO_LARGE:
			return r.folderTooLarge;
		case ErrorReason.GIT_LFS_MISSING:
			return r.gitLfsMissing;
		case ErrorReason.WORKSPACE_NOT_REPOSITORY_ROOT:
			return r.workspaceNotRepositoryRoot;
		case ErrorReason.GIT_COMMIT_SIGNING:
			return r.gitCommitSigning;
		case ErrorReason.GIT_OPERATION_IN_PROGRESS:
			return r.gitOperationInProgress(s);
		case ErrorReason.GIT_DETACHED_HEAD:
			return r.gitDetachedHead;
		case ErrorReason.SENSITIVE_FILE_NOT_CONFIRMED:
			return r.sensitiveFileNotConfirmed;
		case ErrorReason.USAGE_RANGE_INVALID:
			return r.usageRangeInvalid;
		case ErrorReason.USAGE_LEDGER_BLOCKED:
			return r.usageLedgerBlocked;
		case ErrorReason.NOTHING_STAGED:
			return r.nothingStaged;
		default:
			return undefined;
	}
}

/** What to tell the user about a failed request to a machine. */
export function machineErrorText(t: MachinesCopy, err: unknown, ai: string): string {
	if (err instanceof OfflineError) return t.errors.offline;
	if (!(err instanceof RemoteError)) return t.errors.generic;
	const known = reasonText(t.errors.reasons, err, ai);
	if (known !== undefined) return known;
	switch (err.code) {
		case ErrorCode.STALE:
			return t.errors.stale;
		case ErrorCode.NEEDS_LOGIN:
			return t.errors.needsLogin(ai);
		case ErrorCode.PROVIDER_UNAVAILABLE:
			return t.errors.unavailable(ai);
		case ErrorCode.QUEUED:
			return t.errors.queued;
		case ErrorCode.NOT_FOUND:
			return t.errors.notFound;
		case ErrorCode.INVALID:
			return t.errors.invalid(err.message);
		default:
			return t.errors.generic;
	}
}

/** The machine refused to load project settings it does not trust yet; trusting from this device may fix it. */
export function needsProjectTrust(err: unknown): boolean {
	return err instanceof RemoteError && err.reason === ErrorReason.PROJECT_SETTINGS_UNTRUSTED;
}

/** The machine's agent does not know the request (an older tunelo): the page asks to update it instead of failing. */
export function unsupportedByMachine(err: unknown): boolean {
	return err instanceof RemoteError && err.reason === ErrorReason.UNSUPPORTED_REQUEST;
}

/** The machine thinks the session is open elsewhere on it; asking the user first, then opening anyway, is fine. */
export function openElsewhere(err: unknown): boolean {
	return err instanceof RemoteError && err.reason === ErrorReason.SESSION_OPEN_ELSEWHERE;
}
