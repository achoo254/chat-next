// The state of a machine's link above a page, when it is not simply open:
// connecting, offline and retrying (attempt N), or a lasting failure with
// what to do about it (wait for the machine, refresh, sign in again, update).
import { brand } from "../brand.ts";
import { Icon } from "../components/screen-icons.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import type { LinkFailure, LinkStatus } from "./link/machine-link.ts";
import { RefreshMachine } from "./refresh-machine.tsx";
import { useMachinesCopy } from "./use-machines-copy.ts";

/** What a lasting failure means and what to do about it, in a sentence. */
export function failureText(t: MachinesCopy, reason: LinkFailure): string {
	switch (reason) {
		case "refused":
			return t.link.refused;
		case "revoked":
			return t.link.revoked;
		case "key-changed":
			return t.link.keyChanged;
		case "version":
			return t.link.version;
		case "session-revoked":
			return t.link.sessionRevoked;
		case "too-many-devices":
			return t.link.tooManyDevices;
		case "machine-unsynced":
			return t.link.machineUnsynced(brand.appName);
	}
}

export function LinkBanner({ machine, name, status }: { machine: string; name: string; status: LinkStatus }) {
	const t = useMachinesCopy();
	switch (status.kind) {
		case "open":
		case "idle":
			return null;
		case "connecting":
			return status.attempt <= 1 ? (
				<div className="mx-strip" role="status">
					<span className="spin" aria-hidden="true" />
					<span className="grow">{t.link.connecting}</span>
					<RefreshMachine machine={machine} />
				</div>
			) : (
				<div className="mx-strip warn" role="status">
					<Icon name="wifi-off" small />
					<span className="grow">{t.link.offline(name, status.attempt)}</span>
					<RefreshMachine machine={machine} />
				</div>
			);
		case "offline":
			return (
				<div className="mx-strip warn" role="status">
					<Icon name="wifi-off" small />
					<span className="grow">{t.link.offline(name, Math.max(1, status.attempt))}</span>
					<RefreshMachine machine={machine} />
				</div>
			);
		case "failed":
			return (
				<div className="mx-strip error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{failureText(t, status.reason)}</span>
					<RefreshMachine machine={machine} />
				</div>
			);
	}
}
