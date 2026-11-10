// Six one-digit boxes for a 6-digit Authenticator code: typing moves on,
// pasting (or the phone's one-time-code suggestion) fills them all, and the
// sixth digit submits. Give it a new `key` to clear it after a wrong code.
import { useRef, useState, type ReactElement } from "react";
import { useMachinesCopy } from "./use-machines-copy.ts";

export function CodeInput({ label, disabled, onCode }: { label: string; disabled: boolean; onCode: (code: string) => void }): ReactElement {
	const t = useMachinesCopy();
	const [digits, setDigits] = useState<string[]>(() => Array.from({ length: 6 }, () => ""));
	const boxes = useRef<(HTMLInputElement | null)[]>([]);
	const put = (from: number, text: string) => {
		const clean = text.replace(/\D/g, "");
		if (clean === "") return;
		const next = [...digits];
		for (let i = 0; i < clean.length && from + i < 6; i++) next[from + i] = clean[i] ?? "";
		setDigits(next);
		const after = Math.min(from + clean.length, 5);
		boxes.current[after]?.focus();
		if (next.every((d) => d !== "")) onCode(next.join(""));
	};
	return (
		<div className="mx-otp" role="group" aria-label={label}>
			{digits.map((digit, i) => (
				<input
					key={i}
					ref={(el) => {
						boxes.current[i] = el;
					}}
					className="input"
					inputMode="numeric"
					autoComplete={i === 0 ? "one-time-code" : "off"}
					aria-label={t.pair.digit(i + 1)}
					value={digit}
					disabled={disabled}
					onChange={(event) => {
						const value = event.target.value;
						if (value === "") {
							setDigits((all) => all.map((d, j) => (j === i ? "" : d)));
							return;
						}
						put(i, value.slice(digit === "" ? 0 : 1) || value);
					}}
					onKeyDown={(event) => {
						if (event.key === "Backspace" && digit === "" && i > 0) boxes.current[i - 1]?.focus();
					}}
					onPaste={(event) => {
						event.preventDefault();
						put(i, event.clipboardData.getData("text"));
					}}
				/>
			))}
		</div>
	);
}
