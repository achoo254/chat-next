// Reading untyped JSON (the layout and asset files) without trusting it.

/** A checked file: its value, or every problem found. */
export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function arrayOf(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

export function numberOf(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}
