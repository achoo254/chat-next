/* Shared behaviour of the chat mock pages. Mock only: no product logic. */
(() => {
	const SPRITE = `<svg width="0" height="0" class="sr-only" aria-hidden="true">${String.raw`	<symbol id="i-message" viewBox="0 0 24 24"><path d="M8 9h8M8 13h6M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5l-5 3v-3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h12z"/></symbol>
	<symbol id="i-message-dot" viewBox="0 0 24 24"><path d="M8 9h5M8 13h6M14 4H6a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h2v3l5-3h5a3 3 0 0 0 3-3v-4"/><circle cx="19" cy="5" r="2.5"/></symbol>
	<symbol id="i-search" viewBox="0 0 24 24"><circle cx="10" cy="10" r="7"/><path d="M21 21l-6-6"/></symbol>
	<symbol id="i-send" viewBox="0 0 24 24"><path d="M10 14L21 3M21 3l-6.5 18a.55.55 0 0 1-1 0L10 14l-7-3.5a.55.55 0 0 1 0-1L21 3"/></symbol>
	<symbol id="i-clip" viewBox="0 0 24 24"><path d="M15 7l-6.5 6.5a1.5 1.5 0 0 0 3 3L18 10a3 3 0 0 0-6-6l-6.5 6.5a4.5 4.5 0 0 0 9 9L21 13"/></symbol>
	<symbol id="i-smile" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M9.5 15a3.5 3.5 0 0 0 5 0"/></symbol>
	<symbol id="i-dots" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></symbol>
	<symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></symbol>
	<symbol id="i-checks" viewBox="0 0 24 24"><path d="M7 12l5 5L22 7M2 12l5 5m5-5l5-5"/></symbol>
	<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></symbol>
	<symbol id="i-pin" viewBox="0 0 24 24"><path d="M15 4.5l-4 4L7 10l-1.5 1.5 7 7L14 17l1.5-4 4-4M9 15l-4.5 4.5M14.5 4L20 9.5"/></symbol>
	<symbol id="i-bell" viewBox="0 0 24 24"><path d="M10 5a2 2 0 1 1 4 0 7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 4-6M9 17v1a3 3 0 0 0 6 0v-1"/></symbol>
	<symbol id="i-settings" viewBox="0 0 24 24"><path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h11M19 18h1"/><circle cx="14" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></symbol>
	<symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></symbol>
	<symbol id="i-robot" viewBox="0 0 24 24"><rect x="6" y="4" width="12" height="8" rx="2"/><path d="M12 2v2M9 12v9M15 12v9M5 16l4-2M15 14l4 2M9 18h6M10 8h.01M14 8h.01"/></symbol>
	<symbol id="i-webhook" viewBox="0 0 24 24"><path d="M4.9 13.6A4 4 0 1 0 11 17h6M15.1 20.5A4 4 0 1 0 17 13c-.7 0-1.4.2-2 .5l-3-5.5M16 8a4 4 0 1 0-8 0c0 1.5.8 2.8 2 3.5L7 17"/></symbol>
	<symbol id="i-back" viewBox="0 0 24 24"><path d="M5 12h14M5 12l6 6M5 12l6-6"/></symbol>
	<symbol id="i-moon" viewBox="0 0 24 24"><path d="M12 3h.4a7.5 7.5 0 0 0 7.9 12.4A9 9 0 1 1 12 3z"/></symbol>
	<symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></symbol>
	<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 9h.01M11 12h1v4h1"/></symbol>
	<symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="7" r="4"/><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/></symbol>
	<symbol id="i-laptop" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="10" rx="1"/><path d="M3 19h18"/></symbol>
	<symbol id="i-mobile" viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M11 4h2M12 17h.01"/></symbol>
	<symbol id="i-external" viewBox="0 0 24 24"><path d="M12 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6M11 13l9-9M15 4h5v5"/></symbol>
	<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
	<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3a12 12 0 0 0 8.5 3A12 12 0 0 1 12 21 12 12 0 0 1 3.5 6 12 12 0 0 0 12 3"/></symbol>
	<symbol id="i-reply" viewBox="0 0 24 24"><path d="M9 14l-4-4 4-4M5 10h11a4 4 0 1 1 0 8h-1"/></symbol>
	<symbol id="i-forward" viewBox="0 0 24 24"><path d="M15 14l4-4-4-4M19 10H8a4 4 0 1 0 0 8h1"/></symbol>
	<symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></symbol>
	<symbol id="i-edit" viewBox="0 0 24 24"><path d="M7 7H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-1M20.4 6.6a2.1 2.1 0 0 0-3-3L9 12v3h3l8.4-8.4zM16 5l3 3"/></symbol>
	<symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></symbol>
	<symbol id="i-download" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 11l5 5 5-5M12 4v12"/></symbol>
	<symbol id="i-file" viewBox="0 0 24 24"><path d="M14 3v4a1 1 0 0 0 1 1h4M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/></symbol>
	<symbol id="i-mic" viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M8 21h8M12 17v4"/></symbol>
	<symbol id="i-play" viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></symbol>
	<symbol id="i-photo" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M15 8h.01M3 16l5-5c.9-.9 2.1-.9 3 0l5 5M14 14l1-1c.9-.9 2.1-.9 3 0l3 3"/></symbol>
	<symbol id="i-users" viewBox="0 0 24 24"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.1a4 4 0 0 1 0 7.8M21 21v-2a4 4 0 0 0-3-3.9"/></symbol>
	<symbol id="i-user-plus" viewBox="0 0 24 24"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4M16 19h6M19 16v6"/></symbol>
	<symbol id="i-link" viewBox="0 0 24 24"><path d="M9 15l6-6M11 6l.5-.5a5 5 0 0 1 7 7l-.5.5M13 18l-.4.5a5 5 0 0 1-7.1 0 5 5 0 0 1 0-7l.5-.5"/></symbol>
	<symbol id="i-key" viewBox="0 0 24 24"><circle cx="15" cy="9" r="4"/><path d="M12 12l-8 8v2h3v-2h2v-2h2l1.5-1.5"/></symbol>
	<symbol id="i-code" viewBox="0 0 24 24"><path d="M7 8l-4 4 4 4M17 8l4 4-4 4M14 4l-4 16"/></symbol>
	<symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 9v4M10.4 3.6L2.3 17.1A1.9 1.9 0 0 0 3.9 20h16.2a1.9 1.9 0 0 0 1.6-2.9L13.6 3.6a1.9 1.9 0 0 0-3.2 0zM12 16h.01"/></symbol>
	<symbol id="i-alert-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></symbol>
	<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></symbol>
	<symbol id="i-minimize" viewBox="0 0 24 24"><path d="M5 18h14"/></symbol>
	<symbol id="i-wifi-off" viewBox="0 0 24 24"><path d="M12 18h.01M9.2 15.2a4 4 0 0 1 5.6 0M6.3 12.3a8 8 0 0 1 3.9-2.1M14.4 10.4a8 8 0 0 1 3.3 2M3.5 9.5a12 12 0 0 1 3.5-2.4M10.2 6.1a12 12 0 0 1 10.3 3.4M3 3l18 18"/></symbol>
	<symbol id="i-flag" viewBox="0 0 24 24"><path d="M5 5a5 5 0 0 1 7 0 5 5 0 0 0 7 0v9a5 5 0 0 1-7 0 5 5 0 0 0-7 0V5zM5 21v-7"/></symbol>
	<symbol id="i-ban" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/></symbol>
	<symbol id="i-eye" viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><path d="M21 12c-2.4 4-5.4 6-9 6s-6.6-2-9-6c2.4-4 5.4-6 9-6s6.6 2 9 6"/></symbol>
	<symbol id="i-eye-off" viewBox="0 0 24 24"><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8M16.7 16.7A8.7 8.7 0 0 1 12 18c-3.6 0-6.6-2-9-6 1.3-2.1 2.7-3.7 4.3-4.7M10.2 6.2A9 9 0 0 1 12 6c3.6 0 6.6 2 9 6-.7 1.1-1.4 2.1-2.1 2.9M3 3l18 18"/></symbol>
	<symbol id="i-chart" viewBox="0 0 24 24"><path d="M4 20h16M6 16v-4M10 16V8M14 16v-6M18 16V5"/></symbol>
	<symbol id="i-inbox" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 13h3l3 3h4l3-3h3"/></symbol>
	<symbol id="i-cloud" viewBox="0 0 24 24"><path d="M7 18a4.6 4.4 0 0 1 0-8.8 5 4.5 0 0 1 9.8 1H18a3.5 3.5 0 0 1 0 7.8H7z"/></symbol>
	<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M11.5 3a17 17 0 0 0 0 18M12.5 3a17 17 0 0 1 0 18"/></symbol>
	<symbol id="i-chevron-right" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></symbol>
	<symbol id="i-chevron-down" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></symbol>
	<symbol id="i-command" viewBox="0 0 24 24"><path d="M7 9a2 2 0 1 1 2-2v10a2 2 0 1 1-2-2h10a2 2 0 1 1-2 2V7a2 2 0 1 1 2 2H7"/></symbol>
	<symbol id="i-apps" viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 17h6M17 14v6"/></symbol>
	<symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M3 12h1M12 3v1M20 12h1M12 20v1M5.6 5.6l.7.7M18.4 5.6l-.7.7M17.7 17.7l.7.7M6.3 17.7l-.7.7"/></symbol>
	<symbol id="i-logout" viewBox="0 0 24 24"><path d="M14 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2M9 12h12l-3-3M18 15l3-3"/></symbol>
	<symbol id="i-megaphone" viewBox="0 0 24 24"><path d="M18 8a3 3 0 0 1 0 6M10 8v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-5M12 8l4.5-3.8a.9.9 0 0 1 1.5.7v12.2a.9.9 0 0 1-1.5.7L12 14H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h8"/></symbol>
	<symbol id="i-hash" viewBox="0 0 24 24"><path d="M5 9h14M5 15h14M11 4L7 20M17 4l-4 16"/></symbol>
	<symbol id="i-database" viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6a8 3 0 0 0 16 0V6M4 12v6a8 3 0 0 0 16 0v-6"/></symbol>
	<symbol id="i-language" viewBox="0 0 24 24"><path d="M4 5h7M9 3v2c0 4.4-2.2 8-5 8M5 9c0 2.1 3 3.9 6.7 4M12 20l4-9 4 9M19.1 18h-6.2"/></symbol>
	<symbol id="i-bell-off" viewBox="0 0 24 24"><path d="M9.3 5.2A2 2 0 0 1 14 5a7 7 0 0 1 4 6v3M17 17H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 1.4-4.2M9 17v1a3 3 0 0 0 6 0v-1M3 3l18 18"/></symbol>
	<symbol id="i-arrow-down" viewBox="0 0 24 24"><path d="M12 5v14M18 13l-6 6M6 13l6 6"/></symbol>
	<symbol id="i-camera" viewBox="0 0 24 24"><path d="M5 7h1a2 2 0 0 0 2-2 1 1 0 0 1 1-1h6a1 1 0 0 1 1 1 2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2"/><circle cx="12" cy="13" r="3"/></symbol>
	<symbol id="i-qrcode" viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/></symbol>
	<symbol id="i-contacts" viewBox="0 0 24 24"><path d="M20 6v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2zM10 16h6M4 8h3M4 12h3M4 16h3"/><circle cx="13" cy="11" r="2"/></symbol>
	<symbol id="i-user-check" viewBox="0 0 24 24"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4M15 19l2 2 4-4"/></symbol>
	<symbol id="i-user-minus" viewBox="0 0 24 24"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4M16 19h6"/></symbol>
	<symbol id="i-crown" viewBox="0 0 24 24"><path d="M12 6l4 6 5-4-2 10H5L3 8l5 4z"/></symbol>`}</svg>`;
	document.body.insertAdjacentHTML("afterbegin", SPRITE);

	const PAGES = [
		["index.html", "Mục lục"],
		["auth.html", "Đăng nhập"],
		["chat.html", "Nhắn tin"],
		["media.html", "Media"],
		["search.html", "Tìm kiếm"],
		["bots.html", "Bot & Mini App"],
		["console.html", "Developer Console"],
		["integrations.html", "Webhook"],
		["settings.html", "Cài đặt"],
		["moderation.html", "Kiểm duyệt"],
		["mobile.html", "Mobile"],
		["desktop.html", "Desktop"],
	];

	const $ = (s, r = document) => r.querySelector(s);
	const $$ = (s, r = document) => [...r.querySelectorAll(s)];

	// Theme: the ecosystem tokens switch on data-theme; remember the choice.
	// ?theme=light|dark forces a theme (used for review screenshots).
	const forced = new URLSearchParams(location.search).get("theme");
	const savedTheme = forced === "light" || forced === "dark" ? forced : localStorage.getItem("mock-theme");
	if (savedTheme) document.documentElement.dataset.theme = savedTheme;

	// Review bar: page navigation and theme toggle (not part of the product).
	const bar = $(".review-bar");
	if (bar) {
		const here = location.pathname.split("/").pop() || "index.html";
		const links = PAGES.map(([href, label]) =>
			`<a href="${href}"${href === here ? ' aria-current="page"' : ""}>${label}</a>`).join("");
		const dark = document.documentElement.dataset.theme === "dark";
		bar.innerHTML = `<strong>Mock Chat</strong><nav aria-label="Trang mock">${links}</nav>
			<button type="button" class="icon-btn" id="theme-toggle" aria-pressed="${dark}" aria-label="Giao diện tối">
				<svg class="icon"><use href="#i-moon"/></svg></button>
			<span class="review-note">Mock tĩnh để duyệt giao diện, dữ liệu là minh hoạ.</span>`;
		$("#theme-toggle").addEventListener("click", (e) => {
			const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
			document.documentElement.dataset.theme = next;
			localStorage.setItem("mock-theme", next);
			e.currentTarget.setAttribute("aria-pressed", String(next === "dark"));
		});
	}

	// Toast
	document.body.insertAdjacentHTML("beforeend", '<div class="toast" id="toast" role="status" aria-live="polite"></div>');
	const toastEl = $("#toast");
	let toastTimer;
	const toast = (text) => {
		toastEl.textContent = text;
		toastEl.classList.add("show");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2400);
	};

	document.addEventListener("click", (e) => {
		const t = e.target instanceof Element ? e.target : null;
		if (!t) return;
		const toastBtn = t.closest("[data-toast]");
		if (toastBtn) toast(toastBtn.dataset.toast);
		// Copy buttons: the icon turns into a tick for a moment, the label says it was copied.
		const copyBtn = t.closest("[data-copied]");
		if (copyBtn && !copyBtn.dataset.label) {
			const use = copyBtn.querySelector("use");
			copyBtn.dataset.label = copyBtn.getAttribute("aria-label") || "";
			use?.setAttribute("href", "#i-check");
			copyBtn.setAttribute("aria-label", copyBtn.dataset.copied);
			toast(copyBtn.dataset.copied);
			setTimeout(() => {
				use?.setAttribute("href", "#i-copy");
				copyBtn.setAttribute("aria-label", copyBtn.dataset.label);
				delete copyBtn.dataset.label;
			}, 1600);
		}
		// Buttons that wait for a server answer: busy, then a toast.
		const press = t.closest("[data-press]");
		if (press && press.getAttribute("aria-busy") !== "true") {
			press.setAttribute("aria-busy", "true");
			setTimeout(() => { press.removeAttribute("aria-busy"); toast(press.dataset.press); }, 450);
		}
		const sw = t.closest(".switch");
		if (sw) sw.setAttribute("aria-checked", String(sw.getAttribute("aria-checked") !== "true"));
		const choice = t.closest(".choice button, .seg button[aria-pressed]");
		if (choice) $$("button", choice.parentElement).forEach((b) => b.setAttribute("aria-pressed", String(b === choice)));
		const tab = t.closest('[role="tab"]');
		if (tab) {
			const list = tab.closest('[role="tablist"]');
			$$('[role="tab"]', list).forEach((b) => {
				const on = b === tab;
				b.setAttribute("aria-selected", String(on));
				const panel = b.getAttribute("aria-controls");
				if (panel && document.getElementById(panel)) document.getElementById(panel).hidden = !on;
			});
		}
		// Dialogs: data-open="<dialog id>" and data-close inside a dialog.
		const opener = t.closest("[data-open]");
		if (opener) document.getElementById(opener.dataset.open)?.showModal();
		const closer = t.closest("[data-close]");
		if (closer) closer.closest("dialog")?.close();
	});

	// Reaction pills: a click adds or removes your reaction; right-click, the context-menu key
	// or a long press opens "Ai đã thả cảm xúc". Labels read like "👍 3 người, gồm bạn".
	const MY_AVATAR = '<span class="avatar av-violet" data-name="bạn">ĐT</span>';
	const reactionLabel = (btn) => {
		const emoji = $(".r-emoji", btn).textContent;
		const names = $$(".r-avs .avatar", btn).map((a) => a.dataset.name);
		if (names.length) return `${emoji} ${names.length} người: ${names.join(", ")}`;
		const mine = btn.getAttribute("aria-pressed") === "true";
		return `${emoji} ${$(".r-n", btn).textContent} người${mine ? ", gồm bạn" : ""}`;
	};
	const toggleReaction = (btn) => {
		const mine = btn.getAttribute("aria-pressed") !== "true";
		const emoji = $(".r-emoji", btn).textContent;
		const count = $(".r-n", btn);
		const avatars = $(".r-avs", btn);
		let left = 0;
		if (count) {
			left = Number(count.textContent) + (mine ? 1 : -1);
			count.textContent = String(left);
		} else if (avatars) {
			if (mine) avatars.insertAdjacentHTML("afterbegin", MY_AVATAR);
			else $('[data-name="bạn"]', avatars)?.remove();
			left = avatars.children.length;
		}
		toast(mine ? `Đã thả ${emoji}` : `Đã bỏ ${emoji}`);
		if (left === 0) {
			const group = btn.parentElement;
			btn.remove();
			if (!group.children.length) group.remove();
			return;
		}
		btn.setAttribute("aria-pressed", String(mine));
		btn.setAttribute("aria-label", reactionLabel(btn));
	};
	const openReactors = () => toast("Mở “Ai đã thả cảm xúc”, chia theo từng biểu cảm (xem màn Nội dung tin phong phú)");
	let pressTimer = 0;
	let longPressed = false;
	document.addEventListener("click", (e) => {
		const btn = e.target instanceof Element ? e.target.closest(".reactions .reaction") : null;
		if (!btn) return;
		if (longPressed) { longPressed = false; return; }
		toggleReaction(btn);
	});
	document.addEventListener("contextmenu", (e) => {
		const btn = e.target instanceof Element ? e.target.closest(".reactions .reaction") : null;
		if (!btn) return;
		e.preventDefault();
		openReactors();
	});
	document.addEventListener("pointerdown", (e) => {
		const btn = e.target instanceof Element ? e.target.closest(".reactions .reaction") : null;
		if (!btn || e.pointerType === "mouse") return;
		longPressed = false;
		pressTimer = setTimeout(() => { longPressed = true; openReactors(); }, 500);
	});
	["pointerup", "pointercancel", "pointerleave"].forEach((type) => document.addEventListener(type, () => clearTimeout(pressTimer)));

	// Resizable chat list column: drag the edge or use the arrow keys; clamped to 280–420px.
	$$("[data-list-resize]").forEach((handle) => {
		const app = handle.closest(".app");
		const list = handle.closest(".list");
		const MIN = 280, MAX = 420, STEP = 20;
		const set = (w) => {
			const v = Math.round(Math.min(MAX, Math.max(MIN, w)));
			app.style.setProperty("--list-w", `${v}px`);
			handle.setAttribute("aria-valuenow", String(v));
		};
		handle.addEventListener("pointerdown", (e) => {
			const startX = e.clientX, startW = list.getBoundingClientRect().width;
			handle.setPointerCapture(e.pointerId);
			handle.dataset.drag = "";
			const move = (ev) => set(startW + ev.clientX - startX);
			const up = () => { delete handle.dataset.drag; handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", up);
		});
		handle.addEventListener("keydown", (e) => {
			const w = list.getBoundingClientRect().width;
			const next = { ArrowLeft: w - STEP, ArrowRight: w + STEP, Home: MIN, End: MAX }[e.key];
			if (next !== undefined) { e.preventDefault(); set(next); }
		});
	});

	// Vietnamese fold, the same idea as spec/vi-fold: accent- and đ-insensitive.
	const fold = (s) => s.normalize("NFD").replace(/\p{Mn}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
	const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
	window.Mock = { $, $$, toast, fold, escapeHtml };
})();
