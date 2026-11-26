// How long the band of .msg.flash lasts (messaging.css, msg-focus) plus a beat; the timer
// clears the mark where no animation runs (animations off, a page in the background).
const FLASH_MS = 2600;

const timers = new WeakMap<HTMLElement, number>();

/**
 * Marks the message row a jump landed on (a reply's original, a mention, a
 * search hit): a band across the list fades in behind it and out again by
 * itself (styles: .msg.flash), and the class goes when the fade ends so a
 * later jump to the same message plays it again.
 */
export function flashRow(row: HTMLElement): void {
	const earlier = timers.get(row);
	if (earlier !== undefined) window.clearTimeout(earlier);
	row.classList.remove("flash");
	// Reading the layout restarts the animation when the class is added back at once.
	void row.offsetWidth;
	row.classList.add("flash");
	const clear = (): void => {
		row.classList.remove("flash");
		row.removeEventListener("animationend", onEnd);
		const timer = timers.get(row);
		if (timer !== undefined) window.clearTimeout(timer);
		timers.delete(row);
	};
	const onEnd = (event: AnimationEvent): void => {
		if (event.target === row) clear();
	};
	row.addEventListener("animationend", onEnd);
	timers.set(row, window.setTimeout(clear, FLASH_MS));
}
