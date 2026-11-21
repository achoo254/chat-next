// The parts the leave and delete dialogs add when the group is also in another app (Chat Bridge):
// the note that the action reaches there too, and what stopped a step in the app.
import { Icon } from "../../components/screen-icons.tsx";
import { paths } from "../../router.tsx";
import { BridgeReauthBanner } from "../settings/bridge-reauth-banner.tsx";
import { useBridgeCopy } from "../settings/use-bridge-copy.ts";
import type { LifecycleProblem } from "./use-app-lifecycle.ts";

/** Why a step in the app did not go through: a wrong name, a sign-in needed again, or a failure. */
export function AppProblem({ problem, chatId }: { problem: LifecycleProblem | null; chatId: number }) {
	const t = useBridgeCopy();
	if (problem === null) return null;
	if (problem === "reauth") return <BridgeReauthBanner returnTo={paths.chat(chatId)} />;
	return (
		<p className="note warn" role="alert">
			<Icon name="alert-triangle" />
			<span>{problem === "wrongName" ? t.people.danger.wrongName : t.failed}</span>
		</p>
	);
}

/** A warning line of a dialog: the action reaches the app too. */
export function AppNote({ text }: { text: string }) {
	return (
		<p className="note warn">
			<Icon name="alert-triangle" />
			<span>{text}</span>
		</p>
	);
}
