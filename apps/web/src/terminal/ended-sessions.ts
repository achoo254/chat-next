// Terminal sessions the user ended on purpose ("Kết thúc"), so their pane
// says the session ended rather than showing the exit code of the hangup
// (129 is SIGHUP from our own End). Kept for the page's lifetime only.
const ended = new Set<string>();
const key = (machine: string, session: number) => `${machine}/${session}`;

export function endOnPurpose(machine: string, session: number): void {
	ended.add(key(machine, session));
}

export function endedOnPurpose(machine: string, session: number): boolean {
	return ended.has(key(machine, session));
}
