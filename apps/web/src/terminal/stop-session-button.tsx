// The stop button at the end of a machine session's row (the "+" menu and the
// phone's tab sheet). Stopping hangs up a program that may be in the middle
// of something, so it asks once more in place: the first press turns the
// button into a red "Dừng?" for a few seconds, the second one stops. An
// exited session has nothing left to stop: one press drops it from the list.
import { useEffect, useState } from "react";
import { Icon } from "../components/screen-icons.tsx";
import type { MachinesCopy } from "../machines/copy-vi.ts";
import { MachineIcon } from "../machines/machine-icons.tsx";
import type { StopAction } from "./new-tab-actions.ts";

/** How long the armed "Dừng?" waits for the second press. */
const ARMED_MS = 3_000;

export function StopSessionButton({
	t,
	stop,
	className,
	role,
	onStopped,
}: {
	t: MachinesCopy["terminal"];
	stop: StopAction;
	className: string;
	role?: "menuitem" | undefined;
	/** It ran: the row (and this button, which had the focus) goes away. */
	onStopped?: (() => void) | undefined;
}) {
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		if (!armed) return;
		const timer = window.setTimeout(() => setArmed(false), ARMED_MS);
		return () => window.clearTimeout(timer);
	}, [armed]);
	const press = () => {
		if (stop.exited || armed) {
			setArmed(false);
			stop.run();
			onStopped?.();
			return;
		}
		setArmed(true);
	};
	return (
		<button
			type="button"
			role={role}
			className={className}
			disabled={stop.disabled}
			data-armed={armed ? "" : undefined}
			aria-label={armed ? `${stop.label}: ${t.manage.stopArm}` : stop.label}
			title={stop.label}
			onClick={(event) => {
				// The row behind it reopens the session: a press here is only the stop.
				event.stopPropagation();
				press();
			}}
			onBlur={() => setArmed(false)}
		>
			{stop.exited ? <Icon name="x" small /> : <MachineIcon name="power" small />}
			{armed && <span>{t.manage.stopArm}</span>}
		</button>
	);
}
