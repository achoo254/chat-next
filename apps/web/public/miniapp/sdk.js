// Script for Mini App pages, served at https://chat.<domain>/miniapp/sdk.js.
// Load it with <script src="https://chat.<domain>/miniapp/sdk.js"></script>
// and use window.ChatApp. It talks to the chat app that opened the page
// through the bridge (postMessage {type, data}): the chat app's origin is
// not known here, so messages go out with "*" and only messages from the
// parent window are heard. The chat app checks every message (only this
// frame, at its own origin, at most 4 KB) and draws the header, the main
// button and every permission popup itself.
//
// ChatApp.initData is the signed init data (a query string): send it to
// your server and verify it there with the SDK (TypeScript, Python, Go)
// before trusting the user it names. No dependencies.
/* global window, URLSearchParams */
(function () {
	"use strict";

	if (window.ChatApp) return;

	var params = new URLSearchParams(window.location.hash.slice(1));
	var listeners = {};
	var writeCallbacks = [];
	var mainButton = { text: "", visible: false, enabled: true };

	function post(type, data) {
		var message = data === undefined ? { type: type } : { type: type, data: data };
		window.parent.postMessage(message, "*");
	}

	// A throwing callback is reported without stopping the others.
	function call(callback, value) {
		try {
			callback(value);
		} catch (err) {
			window.setTimeout(function () {
				throw err;
			});
		}
	}

	function emit(type, data) {
		var list = (listeners[type] || []).slice();
		for (var i = 0; i < list.length; i++) call(list[i], data);
	}

	function on(type, callback) {
		if (typeof callback !== "function") throw new TypeError("ChatApp: callback must be a function");
		(listeners[type] = listeners[type] || []).push(callback);
	}

	function sendMainButton() {
		post("main_button", { text: mainButton.text, visible: mainButton.visible, enabled: mainButton.enabled });
	}

	var MainButton = {
		get text() {
			return mainButton.text;
		},
		get isVisible() {
			return mainButton.visible;
		},
		get isActive() {
			return mainButton.enabled;
		},
		/** Up to 64 characters. */
		setText: function (text) {
			mainButton.text = String(text).slice(0, 64);
			sendMainButton();
			return MainButton;
		},
		show: function () {
			mainButton.visible = true;
			sendMainButton();
			return MainButton;
		},
		hide: function () {
			mainButton.visible = false;
			sendMainButton();
			return MainButton;
		},
		enable: function () {
			mainButton.enabled = true;
			sendMainButton();
			return MainButton;
		},
		disable: function () {
			mainButton.enabled = false;
			sendMainButton();
			return MainButton;
		},
		onClick: function (callback) {
			on("main_button_pressed", callback);
			return MainButton;
		},
	};

	var ChatApp = {
		/** Signed init data; verify it on your server. */
		initData: params.get("chatAppData") || "",
		/** "light" or "dark", kept up to date. */
		theme: params.get("chatAppTheme") === "dark" ? "dark" : "light",
		MainButton: MainButton,
		/** The page is ready to show. */
		ready: function () {
			post("ready");
		},
		close: function () {
			post("close");
		},
		/** Sends a string (up to 4096 bytes) to the bot and closes the Mini App; only from the bot's private chat or profile. */
		sendData: function (data) {
			if (typeof data !== "string" || data === "") throw new TypeError("ChatApp.sendData: data must be a non-empty string");
			post("data_send", { data: data });
		},
		/** Asks the user, then opens the link in a new tab. */
		openLink: function (url) {
			post("open_link", { url: String(url) });
		},
		/** Asks the user to let the bot message them; callback(granted). */
		requestWriteAccess: function (callback) {
			if (typeof callback === "function") writeCallbacks.push(callback);
			post("request_write_access");
		},
		/** Events: "theme" ({scheme}), "main_button_pressed", "write_access" ({granted}). */
		onEvent: on,
	};

	window.addEventListener("message", function (event) {
		if (event.source !== window.parent) return;
		var message = event.data;
		if (message === null || typeof message !== "object" || typeof message.type !== "string") return;
		var data = message.data;
		switch (message.type) {
			case "theme":
				if (!data || (data.scheme !== "light" && data.scheme !== "dark")) return;
				ChatApp.theme = data.scheme;
				emit("theme", { scheme: data.scheme });
				return;
			case "main_button_pressed":
				emit("main_button_pressed");
				return;
			case "write_access": {
				var granted = !!(data && data.granted === true);
				var callbacks = writeCallbacks;
				writeCallbacks = [];
				for (var i = 0; i < callbacks.length; i++) call(callbacks[i], granted);
				emit("write_access", { granted: granted });
				return;
			}
		}
	});

	window.ChatApp = ChatApp;
})();
