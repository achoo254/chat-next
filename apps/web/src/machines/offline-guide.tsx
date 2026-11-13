// What to do on a machine that is offline, step by step (the machine's
// overview): power it on and sign in, start tunelo, check its status when it
// still does not connect, then wait: the link reconnects by itself, so the
// last step shows it waiting and needs nothing from the user.
import { CopyButton } from "../messaging/ui/parts.tsx";
import { useMachinesCopy } from "./use-machines-copy.ts";

function Command({ text, copy, copied }: { text: string; copy: string; copied: string }) {
	return (
		<div className="mx-cmd">
			<code>{text}</code>
			<CopyButton text={text} label={copy} copiedLabel={copied} small />
		</div>
	);
}

export function OfflineGuide() {
	const g = useMachinesCopy().agent.hint.offline;
	return (
		<section className="card pad mx-card" aria-labelledby="offline-guide-title" data-id="machine-offline-guide">
			<h3 id="offline-guide-title">{g.title}</h3>
			<p className="muted">{g.intro}</p>
			<ol className="mx-steps">
				<li data-id="machine-offline-power">
					<h4>{g.power}</h4>
					<p className="muted">{g.powerBody}</p>
				</li>
				<li data-id="machine-offline-start">
					<h4>{g.start}</h4>
					<p className="muted">{g.startBody}</p>
					<Command text="tunelo start" copy={g.copy} copied={g.copied} />
				</li>
				<li data-id="machine-offline-check">
					<h4>{g.check}</h4>
					<Command text="tunelo status" copy={g.copy} copied={g.copied} />
					<p className="muted">{g.checkBody}</p>
				</li>
				<li className="is-current" data-id="machine-offline-wait">
					<h4>{g.wait}</h4>
					<div className="mx-wait" role="status">
						<span className="spin" aria-hidden="true" />
						{g.waiting}
					</div>
				</li>
			</ol>
		</section>
	);
}
