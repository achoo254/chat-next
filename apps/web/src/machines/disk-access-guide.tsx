// The steps of giving tunelo Full Disk Access on a Mac. tunelo is a
// command-line program in a hidden folder, so it never shows in the
// Applications list: the steps pick it by path in the "+" dialog (Cmd+Shift+G),
// with the path the machine reports when it does; dragging it from the
// Finder window the install command opened is the other way.
import { useMachinesCopy } from "./use-machines-copy.ts";

/** Where the "+" dialog goes to: the program's folder ("~/" for the home folder), and its name. */
export function binaryPlace(binary: string, home: string): { folder: string; name: string } {
	const cut = binary.lastIndexOf("/");
	if (binary === "" || cut <= 0) return { folder: "~/.local/bin/", name: "tunelo" };
	const dir = binary.slice(0, cut);
	const shown = home !== "" && (dir === home || dir.startsWith(`${home}/`)) ? `~${dir.slice(home.length)}` : dir;
	return { folder: `${shown}/`, name: binary.slice(cut + 1) };
}

export function DiskAccessGuide({ binary = "", home = "" }: { binary?: string; home?: string }) {
	const t = useMachinesCopy();
	const { folder, name } = binaryPlace(binary, home);
	return (
		<div className="mx-disk-guide">
			<ol>
				{t.diskAccess.steps(folder, name).map((step) => (
					<li key={step}>{step}</li>
				))}
			</ol>
			<p className="muted">{t.diskAccess.dragNote}</p>
		</div>
	);
}
