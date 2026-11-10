// The per-file upload limit as people read it, shown by the attach menu and
// the drop zone of a chat.

/** "2 GB", "512 MB". */
export function sizeLimitLabel(bytes: number, locale: string): string {
	const gb = bytes / 2 ** 30;
	if (gb >= 1) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(gb)} GB`;
	return `${Math.round(bytes / 2 ** 20)} MB`;
}
