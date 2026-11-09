// On a machine's page (tunelo 2.0.13+, macOS): the machine's whole screen
// through Screen Sharing, opened on the user's tap ("Điều khiển toàn màn
// hình"). The view itself, and noVNC, load only then.
import { useState } from "react";
import type { LinkState, MachineLink } from "../link/machine-link.ts";
import { MachineIcon } from "../machine-icons.tsx";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { ScreenViewHost } from "../browser/takeover-card.tsx";

export function MachineScreen({ link, state, ai }: { link: MachineLink; state: LinkState; ai: string }) {
	const t = useMachinesCopy();
	const [open, setOpen] = useState(false);
	const online = state.status.kind === "open";
	return (
		<section className="card pad mx-card" data-id="machine-screen">
			<h3>{t.screen.title}</h3>
			<p className="note">{t.screen.note}</p>
			<div>
				<button type="button" className="btn btn-sm" disabled={!online} onClick={() => setOpen(true)} data-id="machine-screen-open">
					<MachineIcon name="monitor" small />
					{t.screen.open}
				</button>
			</div>
			{open && <ScreenViewHost link={link} ai={ai} online={online} inSession={false} onClose={() => setOpen(false)} />}
		</section>
	);
}
