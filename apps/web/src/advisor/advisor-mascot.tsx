// The Advisor mascot: a small figure floating on every screen of the signed-
// in Chat app (mounted inside MachineLinksProvider, messaging-root.tsx, so
// never on the legal or welcome pages), docked to a side edge, dragged
// anywhere and snapping back to the nearer edge (advisor-drag.ts), where it
// stays per device. Its picture follows its mood: free, thinking (also
// while connecting), with an answer, asleep (the machine is off or needs a
// newer tunelo). A tap opens its bubble, whose code (and the machines'
// link code with it) loads only then (advisor-bubble.tsx); on the machines
// screens, or with a question still waiting after a reload, it loads at
// once. It listens for copies on the whole page (advisor-context.tsx) and
// sets the route's outer context for them.
import "./advisor.css";
import { lazy, Suspense, useEffect, useState, type CSSProperties } from "react";
import type { Route } from "../router.tsx";
import { listenForCopies, setRouteContext, IGNORE_ATTR, type ScopeContext } from "./advisor-context.tsx";
import { useMascotDrag } from "./advisor-drag.ts";
import { advisorStore, useAdvisorState, type AdvisorStore } from "./advisor-store.ts";
import { pictureOf } from "./looks.ts";
import { useAdvisorCopy } from "./use-advisor-copy.ts";
import { useAdvisorIdentity } from "./use-advisor-identity.ts";

const AdvisorLive = lazy(() => import("./advisor-bubble.tsx"));

const CHAT_ROUTES: ReadonlySet<Route["name"]> = new Set(["home", "chat", "invite", "contacts", "bot"]);

/**
 * The outermost context of a copy on this route. A plain chat says only
 * "chat" (no chat id, no name); the machines screens name the machine.
 */
export function routeContextOf(route: Route): ScopeContext {
	if (CHAT_ROUTES.has(route.name)) return { screen: "chat" };
	if (route.name === "machines") {
		const view = route.view;
		return "machine" in view ? { screen: "machine", machine: view.machine } : { screen: "machine" };
	}
	return { screen: route.name };
}

export default function AdvisorMascot({ route, store = advisorStore }: { route: Route; store?: AdvisorStore }) {
	const t = useAdvisorCopy();
	const { name, look, tone } = useAdvisorIdentity();
	const state = useAdvisorState(store);

	useEffect(() => listenForCopies(document, store), [store]);
	// Nothing of the account's Advisor outlives the signed-in app (sign-out, another account).
	useEffect(() => {
		store.keep();
		return () => store.forgetSoon();
	}, [store]);
	useEffect(() => setRouteContext(routeContextOf(route)), [route]);

	// The live part loads once needed and then stays (it keeps the answers coming).
	const [live, setLive] = useState(false);
	if (!live && (state.open || route.name === "machines" || state.questions.length > 0)) setLive(true);

	const drag = useMascotDrag(
		() => store.setOpen(!state.open),
		(dock) => store.setDock(dock),
	);
	const flash = state.flash.startsWith("!") ? (t.answer.errors[state.flash.slice(1)] ?? t.answer.otherError) : state.flash;
	const style = (drag.live === null ? { "--adv-y": String(state.dock.y) } : { left: `${drag.live.left}px`, top: `${drag.live.top}px` }) as CSSProperties;
	return (
		<>
			{!state.hidden && (
				<button
					type="button"
					className="adv-mascot"
					data-side={state.dock.side}
					data-mood={state.mood}
					data-dragging={drag.live !== null ? "" : undefined}
					data-id="advisor-mascot"
					style={style}
					aria-label={`${t.mascot.open(name)} (${t.mascot.moods[state.mood]})`}
					aria-expanded={state.open}
					{...{ [IGNORE_ATTR]: "" }}
					{...drag.handlers}
				>
					<img src={pictureOf(look, state.mood)} alt="" draggable={false} />
					{state.dot && <span className="adv-dot" role="status" aria-label={t.mascot.dot} />}
				</button>
			)}
			{!state.hidden && !state.open && flash !== "" && (
				<button type="button" className="adv-flash" data-side={state.dock.side} style={{ "--adv-y": String(state.dock.y) } as CSSProperties} onClick={() => store.setOpen(true)}>
					{flash}
				</button>
			)}
			{live && (
				<Suspense fallback={null}>
					<AdvisorLive name={name} look={look} tone={tone} store={store} />
				</Suspense>
			)}
		</>
	);
}
