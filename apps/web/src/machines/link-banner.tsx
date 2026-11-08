// The state of a machine's link above a page, when it is not simply open:
// connecting, offline and retrying (attempt N), or a lasting failure with
// what to do about it (pair this device, update).
import { Icon } from "../components/screen-icons.tsx";
import { Link, paths } from "../router.tsx";
import { LOCAL_REF } from "./link/link-hub.ts";
import type { LinkStatus } from "./link/machine-link.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

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
					{t.link.connecting}
				</div>
			) : (
				<div className="mx-strip warn" role="status">
					<Icon name="wifi-off" small />
					{t.link.offline(name, status.attempt)}
				</div>
			);
		case "offline":
			return (
				<div className="mx-strip warn" role="status">
					<Icon name="wifi-off" small />
					{t.link.offline(name, Math.max(1, status.attempt))}
				</div>
			);
		case "failed": {
			const text =
				status.reason === "unpaired"
					? t.link.unpaired
					: status.reason === "refused"
						? t.link.refused
						: status.reason === "revoked"
							? t.link.revoked
							: status.reason === "key-changed"
								? t.link.keyChanged
								: t.link.version;
			const pairable = status.reason !== "version" && status.reason !== "revoked";
			return (
				<div className="mx-strip error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{text}</span>
					{pairable && (
						<Link to={machine === LOCAL_REF ? paths.machinesLocal() : paths.machinePair(machine)} className="btn btn-sm">
							{t.link.pair}
						</Link>
					)}
				</div>
			);
		}
	}
}
