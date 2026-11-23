// A lost GPU context (the browser reclaimed it: too many contexts, a driver
// reset, an iOS app in the background). On loss the scene stops drawing and
// shows the still plate; on restore PixiJS uploads its textures again from
// the sources it keeps, and the scene is drawn from the current Live Map
// state. A second loss within REPEAT_LOSS_MS stays on the still plate: a GPU
// that keeps dropping the context would otherwise flicker forever.

export const REPEAT_LOSS_MS = 60_000;

export interface ContextGuardHandlers {
	/** Stop drawing, show the still plate. */
	lost(): void;
	/** Draw the current state again. */
	restored(): void;
	/** Lost twice within REPEAT_LOSS_MS: stay still for good. */
	givenUp(): void;
}

export interface ContextGuard {
	readonly lost: boolean;
	readonly givenUp: boolean;
	dispose(): void;
}

export function guardContext(canvas: EventTarget, handlers: ContextGuardHandlers, now: () => number = () => performance.now()): ContextGuard {
	let lost = false;
	let givenUp = false;
	let lastLoss: number | null = null;
	const onLost = (): void => {
		if (givenUp) return;
		const at = now();
		const repeat = lastLoss !== null && at - lastLoss < REPEAT_LOSS_MS;
		lastLoss = at;
		lost = true;
		handlers.lost();
		if (repeat) {
			givenUp = true;
			handlers.givenUp();
		}
	};
	const onRestored = (): void => {
		if (givenUp || !lost) return;
		lost = false;
		handlers.restored();
	};
	canvas.addEventListener("webglcontextlost", onLost);
	canvas.addEventListener("webglcontextrestored", onRestored);
	return {
		get lost() {
			return lost;
		},
		get givenUp() {
			return givenUp;
		},
		dispose() {
			canvas.removeEventListener("webglcontextlost", onLost);
			canvas.removeEventListener("webglcontextrestored", onRestored);
		},
	};
}
