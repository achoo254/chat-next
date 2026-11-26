// The notice the page splash turns into once an error unmounted the app
// (error-recovery.ts). It is a lazy chunk so the startup bundle stays small.

// The notice is written after React has unmounted the app, when the copy of
// the UI language may not be loaded, so its few words live here.
// chunk: a lazy part of the app could not be loaded twice in a row; crash: any
// other error that reached the top and unmounted the app.
export type NoticeKind = "chunk" | "crash";
const NOTICE: Record<string, { chunk: string; crash: string; reload: string }> = {
	vi: { chunk: "Không tải được phần mới của ứng dụng.", crash: "Ứng dụng gặp lỗi và đã dừng.", reload: "Tải lại" },
	en: { chunk: "Couldn't load the new version of the app.", crash: "Something went wrong and the app stopped.", reload: "Reload" },
	zh: { chunk: "无法加载应用的新版本。", crash: "应用出错，已停止运行。", reload: "重新加载" },
};

/** Turns the page splash, which shows again once the app is unmounted, into a message with a reload button. */
export function showReloadNotice(kind: NoticeKind = "chunk", doc: Document = document): void {
	const splash = doc.getElementById("splash");
	if (splash === null) return;
	const lang = doc.documentElement.lang.slice(0, 2).toLowerCase();
	const words = NOTICE[lang] ?? NOTICE.vi;
	splash.hidden = false;
	splash.setAttribute("aria-busy", "false");
	splash.classList.add("reload-notice");
	const text = splash.querySelector(".brand-loader-text") ?? splash.appendChild(doc.createElement("p"));
	text.textContent = words?.[kind] ?? "";
	if (splash.querySelector("button") !== null) return;
	const button = doc.createElement("button");
	button.type = "button";
	button.className = "btn";
	button.textContent = words?.reload ?? "";
	button.addEventListener("click", () => location.reload());
	splash.appendChild(button);
}
