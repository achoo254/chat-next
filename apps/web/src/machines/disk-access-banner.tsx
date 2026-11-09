// A Mac whose tunelo lacks Full Disk Access: its sessions cannot open the
// protected folders and may hang on a macOS prompt nobody at the machine
// answers. Only the owner can grant it, on the machine; this says how, and
// asks the machine again once they did.
import type { MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import type { MachineLink } from "./link/machine-link.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

export function DiskAccessBanner({ link, info, online }: { link: Pick<MachineLink, "request">; info: MachineInfo | null; online: boolean }) {
	const t = useMachinesCopy();
	if (info?.needsFullDiskAccess !== true) return null;
	return (
		<div className="mx-strip warn mx-disk-access" role="alert" data-id="disk-access">
			<Icon name="alert" small />
			<div className="grow">
				<b>{t.diskAccess.title}</b>
				<p>{t.diskAccess.body}</p>
				<ol>
					{t.diskAccess.steps.map((step) => (
						<li key={step}>{step}</li>
					))}
				</ol>
			</div>
			<button
				type="button"
				className="btn btn-sm"
				data-id="disk-access-recheck"
				disabled={!online}
				onClick={() => link.request({ case: "machineInfoRequest", value: {} }).catch(() => undefined)}
			>
				{t.diskAccess.recheck}
			</button>
		</div>
	);
}
