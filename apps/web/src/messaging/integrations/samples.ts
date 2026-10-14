// Sample requests and tool configurations per hook format, shown next to
// the one-time URL ("Thử ngay") and in the connection guide. Pure, so the
// shapes are unit-tested against what the server parses (server/README.md,
// Webhook): Native JSON and Slack take `text`, Alertmanager and Grafana an
// alert group, GitLab a project event with `object_kind`.
import type { HookFormat } from "./api.ts";

/** Quotes for a POSIX shell: single quotes, with embedded ones closed and escaped. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The test payload of a format; `greeting` is the localized "Hello from <hook name>". */
export function samplePayload(format: HookFormat, greeting: string): unknown {
	switch (format) {
		case "native":
			return { text: greeting };
		case "slack":
			return { text: greeting };
		case "alertmanager":
			return {
				version: "4",
				status: "firing",
				groupKey: "test-webhook",
				alerts: [{ status: "firing", labels: { alertname: "TestWebhook", instance: "lab-01" }, annotations: { summary: greeting } }],
			};
		case "grafana":
			return {
				status: "firing",
				groupKey: "test-webhook",
				title: "[FIRING:1] TestWebhook",
				message: greeting,
				alerts: [{ status: "firing", labels: { alertname: "TestWebhook", instance: "lab-01" }, annotations: { summary: greeting } }],
			};
		case "gitlab":
			return {
				object_kind: "push",
				user_name: "GitLab",
				ref: "refs/heads/main",
				total_commits_count: 1,
				project: { path_with_namespace: "group/project" },
				commits: [{ id: "0123456789abcdef0123456789abcdef01234567", title: greeting }],
			};
	}
}

/** A curl command that posts the format's test payload to `url`. */
export function sampleCommand(format: HookFormat, url: string, greeting: string): string {
	const body = JSON.stringify(samplePayload(format, greeting), null, format === "native" || format === "slack" ? undefined : 2);
	const lines = [`curl -X POST ${shellQuote(url)}`, "  -H 'Content-Type: application/json'"];
	if (format === "gitlab") lines.push("  -H 'X-Gitlab-Event: Push Hook'");
	lines.push(`  -d ${shellQuote(body)}`);
	return lines.join(" \\\n");
}

/** What a successful request answers: Slack-compatible senders compare the text "ok". */
export function sampleResponse(format: HookFormat): string {
	return format === "slack" ? "ok" : '{"chat_id": …, "seq": …}';
}

/** Configuration snippet of the usual tool for a format; `{URL}` stands for the saved webhook URL. */
export function guideSnippet(format: HookFormat, chatSlug: string): string {
	switch (format) {
		case "native":
			return [
				"post {",
				"  failure {",
				"    withCredentials([string(credentialsId: 'chat-hook-url', variable: 'HOOK')]) {",
				`      sh '''curl -fsS -X POST "$HOOK" -H 'Content-Type: application/json' \\`,
				`        -d "{\\"text\\": \\"$JOB_NAME #$BUILD_NUMBER failed\\", \\"idempotency_key\\": \\"$BUILD_TAG\\"}"'''`,
				"    }",
				"  }",
				"}",
			].join("\n");
		case "slack":
			return ["Notification Type: Slack", `Friendly Name:     ${chatSlug}`, "Webhook URL:       {URL}", "Default enabled:   on"].join("\n");
		case "alertmanager":
			return [
				"# alertmanager.yml",
				"route:",
				`  receiver: ${chatSlug}`,
				"receivers:",
				`  - name: ${chatSlug}`,
				"    webhook_configs:",
				'      - url: "{URL}"',
				"        send_resolved: true",
			].join("\n");
		case "grafana":
			return [
				"# provisioning/alerting/contact-points.yaml",
				"apiVersion: 1",
				"contactPoints:",
				"  - orgId: 1",
				`    name: ${chatSlug}`,
				"    receivers:",
				`      - uid: ${chatSlug}`,
				"        type: webhook",
				"        settings:",
				'          url: "{URL}"',
				"          httpMethod: POST",
			].join("\n");
		case "gitlab":
			return ["URL:      {URL}", "Triggers: Push events, Merge request events, Pipeline events, Deployment events", "SSL verification: on"].join("\n");
	}
}
