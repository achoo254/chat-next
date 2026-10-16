// English copy of the incoming webhook screens; keys mirror copy-vi.ts.
import type { HooksCopy } from "./copy-vi.ts";

const kind = (channel: boolean): string => (channel ? "channel" : "group");

export const enHooks: HooksCopy = {
	title: (channel) => `Webhooks of this ${kind(channel)}`,
	crumb: "Webhooks",
	backToAdmin: (channel) => `Back to ${kind(channel)} management`,
	backToList: "Back to webhooks",
	create: "Create webhook",
	creating: "Creating…",
	manage: "Manage",
	manageName: (name) => `Manage webhook ${name}`,
	columns: { hook: "Webhook", format: "Format", creator: "Created by", lastUsed: "Last received", state: "Status", actions: "Actions" },
	neverUsed: "Never",
	emptyTitle: "No webhooks yet",
	emptyBody: (channel) =>
		`Webhooks let monitoring, CI/CD or scripts post into this ${kind(channel)} through a secret URL. Their messages show the label "Integration: <name>".`,
	membersNote: (channel) => `${channel ? "Subscribers" : "Regular members"} see integration messages in the chat, not this list.`,
	limitReached: (max) => `This chat has ${max} webhooks, the most a chat can have. Delete one you no longer use to add another.`,
	state: {
		active: "Active",
		disabled: "Turned off",
		auto_disabled: "Turned off automatically",
		rotating: "Rotating secret",
	},
	stateSub: {
		creatorNotAdmin: "Its creator is no longer an admin",
		creatorLeft: (channel) => `Its creator left the ${kind(channel)}`,
		byModerator: "Turned off by the moderation team",
		byAdmin: "Turned off by an admin",
		silent: "Sends silently",
		oldUrl: (left) => `Old URL expires in ${left}`,
	},
	formats: {
		native: { name: "Native JSON", note: "text, buttons, group_key, idempotency_key. For scripts and Jenkins." },
		slack: { name: "Slack-compatible", note: "Grafana, Uptime Kuma, GitLab through Mattermost. Understands mrkdwn." },
		alertmanager: { name: "Alertmanager", note: "Alerts with the same groupKey update in place, firing to resolved." },
		grafana: { name: "Grafana", note: "Webhook contact point: updates in place like Alertmanager, with Dashboard and Panel buttons." },
		gitlab: { name: "GitLab", note: "Project webhooks: push, merge request, pipeline, deployment, issue, release." },
	},
	form: {
		name: "Name",
		nameHint: 'People in the chat see this name in the label "Integration: <name>". A webhook cannot pose as a user.',
		nameRequired: "Enter a name for the webhook",
		nameTooLong: (max) => `The name can be at most ${max} characters`,
		format: "Format",
		formatHint: "The format decides the URL suffix and how the payload is read.",
		allowAlert: "Allow alert priority",
		allowAlertNote: 'Payloads with priority "alert" take the fastest push lane. When off, every message of the webhook has normal priority.',
		silent: "Send silently",
		silentNote: "Messages arrive in the chat without sound or notification.",
		previewTitle: "Messages will look like this",
		previewText: "High CPU on lab-174",
		previewNote: "Anyone with the URL can post into the chat, so the URL is shown only once, right after creation.",
		limit: (max) => `A chat can have at most ${max} webhooks.`,
		invalid: "The server did not accept this name or format. Check them and try again.",
	},
	oneTime: {
		createdTitle: (name) => `Webhook ${name} created`,
		rotatedTitle: (name) => `New URL of ${name}`,
		warn: (chat) => `The URL is shown only once. Save it somewhere safe now; anyone with it can post into ${chat}.`,
		urlLabel: (format) => `Webhook URL (${format})`,
		copyUrl: "Copy URL",
		urlCopied: "URL copied",
		tryNow: "Try it now",
		copyCommand: "Copy command",
		commandCopied: "Command copied",
		greeting: (name) => `Hello from ${name}`,
		response: (body) => `Response: ${body}`,
		saved: "I saved the URL",
		savedFirst: 'Turn on "I saved the URL" before closing',
		done: "Done",
		hidden: "The URL is hidden now; only the name and status remain",
	},
	detail: {
		gone: "This webhook no longer exists. Another admin may have deleted it.",
		info: "Webhook",
		format: "Format",
		createdBy: "Created by",
		createdLine: (name, when) => `${name} · ${when}`,
		lastUsed: "Last received",
		silent: "Send silently",
		allowAlert: "Alert priority",
		on: "On",
		off: "Off",
		allowed: "Allowed",
		notAllowed: "Not allowed",
		receiving: "Receive messages",
		receivingNote: "When off, requests to the URL are refused; the URL stays the same.",
		turnedOn: (name) => `${name} turned on`,
		turnedOff: (name) => `${name} turned off; requests to its URL are refused`,
		creatorNotAdmin: "Its creator is no longer an admin. Take the webhook over to turn it on.",
		autoDisabledBanner: (creator, when, left, channel) =>
			`The webhook turned off because ${creator} ${left ? `left the ${kind(channel)}` : `is no longer an admin of the ${kind(channel)}`} (${when}). Requests to its URL are refused.`,
		disabledBanner: (when) => `The webhook has been off since ${when}. Requests to its URL are refused until it is turned on.`,
		moderatorBanner: (when) => `The moderation team turned this webhook off at ${when}. Admins cannot turn it back on or take it over.`,
		takeOver: "Take over webhook",
		takeOverNote: "You become its creator; the webhook runs again at once with its format and settings.",
		rotateOnTakeOver: "Rotate the secret when taking over",
		rotateOnTakeOverNote: (creator) =>
			`Off by default so alerts keep flowing. Turn it on if ${creator} should not use the old URL any more; the new URL is shown once.`,
		takenOver: "Webhook taken over, the URL stays the same",
		takenOverRotated: "Webhook taken over with a new URL",
		secretTitle: "URL and secret",
		secretNote: "The server keeps only a hash of the secret, so the full URL is shown only on creation, rotation, or a take-over with rotation.",
		currentSecret: "Current secret",
		currentSecretSub: (when, by) => `Issued ${when} by ${by}`,
		accepting: "Accepting",
		refused: "Refused",
		previousSecret: "Old secret",
		previousSecretSub: "Still accepted during the grace period",
		expiresIn: "Expires in",
		graceProgress: "Grace period elapsed",
		rotate: "Rotate secret",
		revokePrevious: "Revoke old secret now",
		revokedPrevious: "Old secret revoked; only the new URL works",
		noPrevious: "The old secret has already expired or been revoked",
		statsTitle: "Counters",
		window: "Period",
		windows: { day: "24 hours", week: "7 days", month: "30 days" },
		accepted: "Received",
		acceptedSub: "Requests accepted",
		delivered: "Delivered in real time",
		deliveredSub: "To at least one online session",
		failed: "Failed",
		failedSub: "No message created",
		noPerMember: 'Delivery to each member is not tracked, only these totals. To see who read a message, use "Seen" on it (small groups).',
		failureColumns: { reason: "Failure reason", count: "Count", last: "Latest" },
		noFailures: "No failures in this period.",
		deadTitle: "Failed requests",
		deadNote: "Requests that could not be processed, kept 30 days, newest first. Bodies are kept up to 16 KiB.",
		deadEmpty: "No failed requests.",
		deadStatus: (status) => `HTTP ${status}`,
		deadContentType: (type) => `Content-Type: ${type === "" ? "(none)" : type}`,
		deadBody: "Body",
		deadEmptyBody: "(empty body)",
		deadTruncated: "The body was longer than 16 KiB; the rest was cut.",
		more: "Show more",
		guideTitle: "How to connect",
		copySnippet: "Copy configuration",
		snippetCopied: "Configuration copied",
		guideUrl: "{URL} is the URL you saved when creating the webhook, format suffix included.",
		dangerTitle: "Delete webhook",
		dangerNote: "The URL stops at once. Messages already sent stay in the chat; the log is kept.",
		delete: "Delete webhook",
	},
	failures: {
		rate_limited: "Rate limit exceeded",
		payload_too_large: "Payload larger than 64 KB",
		invalid_json: "Malformed JSON",
		invalid_payload: "Payload does not match the chosen format",
		text_empty: "No content",
		text_too_long: "Text longer than 4096 characters",
		url_not_allowed: "Link with a scheme that is not allowed",
		hook_disabled: "Webhook turned off",
		chat_unavailable: "Chat no longer exists",
		internal: "Server error",
	},
	guides: {
		native: [
			"Create a Native JSON webhook; turn on Send silently if it only reports successful builds.",
			"Save the URL in Jenkins Credentials (Secret text) with the id chat-hook-url.",
			"Add a post step that calls curl; idempotency_key prevents duplicates when Jenkins retries.",
		],
		slack: [
			"Grafana: Alerting → Contact points → Add contact point, pick the Slack integration and paste the URL as Webhook URL.",
			"GitLab: Settings → Integrations → Mattermost notifications, paste the URL as Webhook (GitLab blocks Discord URLs; the new Slack integration needs an app).",
			"Uptime Kuma: Settings → Notifications → Setup Notification, pick Slack and paste the URL as shown.",
		],
		alertmanager: [
			"Add a webhook_configs receiver pointing at the URL, with send_resolved on.",
			"Reload Alertmanager. Alerts with the same groupKey edit one message in place instead of posting new ones.",
		],
		grafana: [
			"Grafana: Alerting → Contact points → Add contact point, pick the Webhook integration.",
			"Paste the URL, method POST, press Test: the webhook's message shows in the chat.",
			"Alerts of the same group edit one message in place, firing to resolved.",
		],
		gitlab: [
			"GitLab: Settings → Webhooks → Add new webhook.",
			"Paste the URL, pick the events (push, merge request, pipeline, deployment), keep SSL verification on.",
			"Press Test → Push events: the webhook's message shows in the chat. Merge requests and pipelines update in place.",
		],
	},
	rotateDialog: {
		title: (name) => `Rotate the secret of ${name}?`,
		note: "Creates a new URL, shown once. The old URL keeps working for 7 more days so you can update your tools.",
		revokeNow: "Revoke the old URL now",
		revokeNowNote: "For a leaked URL: requests to the old URL are refused at once.",
		confirm: "Rotate secret",
	},
	deleteDialog: {
		title: (name) => `Delete webhook ${name}?`,
		note: "The URL stops at once and cannot be restored. Messages already sent stay in the chat; the log is kept.",
		confirm: "Delete webhook",
		deleted: (name) => `Webhook ${name} deleted`,
	},
	editDialog: {
		open: "Edit settings",
		title: (name) => `Edit webhook ${name}`,
		nameHint: 'The new name labels its next messages as "Integration: <name>"; messages already posted keep the old one.',
		formatNote: (format) => `The ${format} format is part of the URL, so it cannot change. Create another webhook for a different format.`,
		save: "Save",
		saving: "Saving…",
		saved: (name) => `Saved the settings of ${name}`,
	},
	audit: {
		title: "Log",
		chatNote: "Every change to this chat's webhooks, deleted ones included.",
		empty: "No changes yet.",
		server: "System",
		action: (action, actor, hook, detail) => {
			switch (action) {
				case "created":
					return `${actor} created ${hook}`;
				case "secret_rotated":
					return detail === "previous_revoked" ? `${actor} rotated the secret of ${hook} and revoked the old URL at once` : `${actor} rotated the secret of ${hook}`;
				case "previous_secret_revoked":
					return `${actor} revoked the old secret of ${hook}`;
				case "disabled":
					return detail === "by_moderator" ? `The moderation team turned off ${hook}` : `${actor} turned off ${hook}`;
				case "enabled":
					return `${actor} turned on ${hook}`;
				case "auto_disabled":
					return detail === "creator_left" ? `${hook} turned off: its creator left the chat` : `${hook} turned off: its creator is no longer an admin`;
				case "taken_over":
					return `${actor} took over ${hook}`;
				case "deleted":
					return `${actor} deleted ${hook}`;
				case "updated":
					return `${actor} edited ${hook}`;
				case "unknown":
					return `${actor} changed ${hook}`;
			}
		},
		updated: (actor, hook, changes) => {
			const parts: string[] = [];
			if (changes.renamedFrom !== null) parts.push(`renamed “${changes.renamedFrom}” to “${hook}”`);
			if (changes.allowAlert !== null) parts.push(changes.allowAlert ? "allowed Alert priority" : "stopped allowing Alert priority");
			if (changes.silent !== null) parts.push(changes.silent ? "turned on silent sending" : "turned off silent sending");
			return parts.length === 0 ? `${actor} edited ${hook}` : `${actor} edited ${hook}: ${parts.join(", ")}`;
		},
	},
	time: {
		countdown: (days, clock) => (days > 0 ? `${days} ${days === 1 ? "day" : "days"} ${clock}` : clock),
		days: (n) => `${n} ${n === 1 ? "day" : "days"}`,
		hours: (n) => `${n} ${n === 1 ? "hour" : "hours"}`,
	},
	notAvailable: "Only admins of the group or channel can manage webhooks.",
};
