// What AI Agent says to an account with no machine yet (its sessions column,
// the "Cần bạn" board, "Quản lý máy"): what it does, what the machine needs,
// and one large button into "Thêm máy này" (one command installs tunelo and
// pairs). On a phone it says to run the command on the computer to control.
import { Icon } from "../components/screen-icons.tsx";
import { Link, paths } from "../router.tsx";
import { CLI_GUIDE, detectOs } from "./add-machine.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { useMachinesCopy } from "./use-machines-copy.ts";

export function FirstMachine({ compact = false }: { compact?: boolean }) {
	const t = useMachinesCopy();
	const w = t.agent.welcome;
	const phone = detectOs(navigator.userAgent) === "phone";
	return (
		<div className={`empty mx-first${compact ? " compact" : ""}`} data-id="first-machine">
			<MachineIcon name="monitor" />
			<h2>{w.title}</h2>
			<p>{w.body}</p>
			<p className="note">
				{w.needs}{" "}
				<a href={CLI_GUIDE} target="_blank" rel="noreferrer">
					{w.guide}
				</a>
			</p>
			{phone && <p className="note mx-first-phone">{w.onPhone}</p>}
			<Link to={paths.machinesAdd()} className="btn btn-primary btn-lg" data-id="first-machine-add">
				<Icon name="plus" />
				{w.start}
			</Link>
		</div>
	);
}
