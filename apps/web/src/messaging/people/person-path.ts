// The address of a person's screen (ADR 0025: one row per linked person in
// "Tất cả", opening the merged timeline of their private chats). Shared by
// the chat list, which links there, and the router, which reads it back.

/** The path of the screen of person `personId`. */
export function personPath(personId: number): string {
	return `/p/${personId}`;
}

/** The person id in a person path ("/p/12", a trailing slash allowed); null for any other path. */
export function personIdFrom(path: string): number | null {
	const id = Number(/^\/p\/([1-9]\d*)\/?$/.exec(path)?.[1]);
	return Number.isSafeInteger(id) ? id : null;
}
