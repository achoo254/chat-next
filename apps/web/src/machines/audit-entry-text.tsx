// One line of a machine's consent log: who did what, how a device was paired
// (the Authenticator code or the install command on the machine), the path,
// and the detail of the actions that have a readable one.
import type { AuditEntry } from "@achoo254/chat-proto/remote/remote";
import type { MachinesCopy } from "./copy-vi.ts";

/** Actions whose detail is shown as is after the line. */
function showsDetail(action: string): boolean {
	return (
		action === "approve_sensitive" ||
		action === "browser_control" ||
		action === "local_forward" ||
		action === "mcp_local_writes" ||
		action.startsWith("profile_")
	);
}

export function AuditEntryText({ entry, copy }: { entry: AuditEntry; copy: MachinesCopy["detail"] }) {
	return (
		<>
			{entry.device} {copy.auditActions[entry.action] ?? entry.action}
			{entry.action === "pair" && copy.auditPairedBy[entry.detail]}
			{entry.path !== "" && (
				<>
					{" "}
					<span className="mono">{entry.path}</span>
				</>
			)}
			{showsDetail(entry.action) && entry.detail !== "" && <span className="mono"> · {entry.detail}</span>}
		</>
	);
}
