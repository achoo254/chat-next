// The line icons of the Live Map's card and session box: one stroke width and
// one 16-unit grid, drawn with the text colour (currentColor), hidden from
// screen readers (the label beside each carries the meaning).
const PATHS = {
	clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>,
	bars: <path d="M3 13V8M7 13V4M11 13V6M1.5 14h13" />,
	repeat: <path d="M3 7a5 5 0 0 1 9-2M13 9a5 5 0 0 1-9 2M12.5 2v3h-3M3.5 14v-3h3" />,
	layers: <path d="M8 2l6 3-6 3-6-3 6-3zM2 8l6 3 6-3M2 11l6 3 6-3" />,
	pulse: <path d="M1.5 8h3l2-5 3 10 2-5h3" />,
	tools: <path d="M10.5 2.5a3.5 3.5 0 0 0-3.2 4.7L2.5 12 4 13.5l4.8-4.8a3.5 3.5 0 0 0 4.7-3.2l-2 2-2-.5-.5-2 2-2z" />,
	nodes: <><circle cx="8" cy="4" r="2" /><circle cx="3.5" cy="12" r="2" /><circle cx="12.5" cy="12" r="2" /><path d="M7 5.8L4.5 10.2M9 5.8l2.5 4.4" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Ico({ name }: { name: IconName }) {
	return (
		<svg className="lm-ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			{PATHS[name]}
		</svg>
	);
}
