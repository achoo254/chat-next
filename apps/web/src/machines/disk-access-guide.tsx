// The two steps of giving tunelo Full Disk Access on a Mac, with a drawing of
// them: a Finder window with tunelo selected, dragged into the settings list
// whose switch is then on. Drawn here from the page's own colours; no
// screenshot of macOS.
import { useMachinesCopy } from "./use-machines-copy.ts";

function Figure({ label }: { label: string }) {
	return (
		<svg className="mx-disk-figure" viewBox="0 0 320 120" role="img" aria-label={label}>
			{/* Finder window, tunelo selected. */}
			<rect className="f-frame" x="4" y="14" width="112" height="92" rx="8" />
			<line className="f-rule" x1="4" y1="32" x2="116" y2="32" />
			<circle className="f-dot" cx="16" cy="23" r="3" />
			<circle className="f-dot" cx="26" cy="23" r="3" />
			<circle className="f-dot" cx="36" cy="23" r="3" />
			<rect className="f-pick" x="34" y="44" width="52" height="52" rx="8" />
			<rect className="f-app" x="46" y="50" width="28" height="28" rx="6" />
			<path className="f-app-mark" d="M52 58l5 5-5 5M60 70h8" />
			<text className="f-name" x="60" y="91" textAnchor="middle">
				tunelo
			</text>
			{/* Dragged across. */}
			<path className="f-drag" d="M124 60h56" />
			<path className="f-drag-head" d="M174 54l8 6-8 6" />
			{/* System Settings list, tunelo's switch on. */}
			<rect className="f-frame" x="190" y="14" width="126" height="92" rx="8" />
			<rect className="f-row-muted" x="200" y="28" width="106" height="20" rx="4" />
			<rect className="f-row" x="200" y="56" width="106" height="24" rx="4" />
			<rect className="f-app" x="206" y="60" width="16" height="16" rx="4" />
			<text className="f-name" x="228" y="72">
				tunelo
			</text>
			<rect className="f-switch" x="278" y="61" width="22" height="14" rx="7" />
			<circle className="f-knob" cx="293" cy="68" r="5" />
			<rect className="f-row-muted" x="200" y="86" width="106" height="12" rx="4" />
		</svg>
	);
}

export function DiskAccessGuide() {
	const t = useMachinesCopy();
	return (
		<div className="mx-disk-guide">
			<Figure label={t.diskAccess.figure} />
			<ol>
				{t.diskAccess.steps.map((step) => (
					<li key={step}>{step}</li>
				))}
			</ol>
		</div>
	);
}
