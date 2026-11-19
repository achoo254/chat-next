// Settings › Cố vấn › Khoá TypeSafe across several machines: the account's key
// is pasted once and reaches every other machine sealed from machine to
// machine (the page only relays a ticket's public key and opaque bytes), a
// machine's own key stays, a key kept from before is promoted once agreed,
// and a removed key is removed everywhere and never handed on again.
import { createConnectTransport } from "@connectrpc/connect-web";
import type { AdvisorProfile } from "@achoo254/chat-core";
import { AdvisorKeySource } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, utf8, type KeyPair } from "@achoo254/chat-remote-protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viAdvisor } from "../../src/advisor/copy-vi.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { MachineLinksProvider } from "../../src/machines/link/connection-provider.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import AdvisorSettings from "../../src/screens/settings/advisor-settings.tsx";
import { FakeMachines } from "../support/fake-machines.ts";
import { routerFetch } from "../support/router-fetch.ts";
import { containsBytes, fingerprintOf, KeyMachine } from "./fake-key-machine.ts";

const t = viAdvisor;
const WAIT = { timeout: 4000 };
const KEY = "ts_live_0123456789abcdefghijklmnopqrstuvwxyz";
const T0 = 1_800_000_000_000;
let device: KeyPair;
let machines: KeyMachine[];
let profile: AdvisorProfile;
let toasts: string[];

vi.mock("../../src/machines/link/device-keys.ts", () => ({
	deviceKeyStore: () => ({
		device: async () => device,
		renew: async () => device,
		seenMachineKey: async () => null,
		rememberMachineKey: async () => undefined,
		forgetMachineKey: async () => undefined,
	}),
}));

vi.mock("../../src/messaging/data/services.tsx", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../src/messaging/data/services.tsx")>();
	return { ...real, useAdvisorProfile: () => profile, useAdvisorProfileLoaded: () => true };
});

const NativeWebSocket = window.WebSocket;

beforeEach(async () => {
	window.localStorage.clear();
	window.sessionStorage.clear();
	device = await generateKeyPair();
	profile = { name: "", lookId: "owl", tone: "short", autoSession: false, keyRemovedAt: 0 };
	toasts = [];
	machines = [];
	window.WebSocket = function (url: string) {
		const m = machines.find((x) => url.startsWith(x.url));
		if (m === undefined) throw new Error(`no machine at ${url}`);
		return m.machine.factory(url);
	} as unknown as typeof WebSocket;
});

afterEach(() => {
	window.WebSocket = NativeWebSocket;
});

async function addMachine(name: string): Promise<KeyMachine> {
	const m = await KeyMachine.create(name, `wss://m-${machines.length + 1}.tunnel.hoandat.com`, device.publicKey);
	machines.push(m);
	return m;
}

/** Renders Settings › Cố vấn over the machines; `save` stands for the server's profile write. */
function open(save?: (change: Partial<AdvisorProfile>) => Promise<AdvisorProfile>) {
	const directory = new FakeMachines();
	for (const m of machines) directory.add({ name: m.name, tunnelUrl: m.url, lastSeenAt: BigInt(Math.floor(Date.now() / 1000)), publicKey: m.machine.keys.publicKey });
	const transport = createConnectTransport({ baseUrl: "http://localhost/rpc", useBinaryFormat: true, fetch: routerFetch((r) => directory.routes(r)) });
	const setAdvisorProfile = vi.fn(
		save ??
			(async (change: Partial<AdvisorProfile>) => {
				profile = { ...profile, ...change };
				return profile;
			}),
	);
	const services = { toasts: { show: (text: string) => toasts.push(text) }, transport, store: { setAdvisorProfile } } as unknown as Services;
	render(
		<I18nProvider>
			<ServicesContext value={services}>
				<MachineLinksProvider>
					<AdvisorSettings />
				</MachineLinksProvider>
			</ServicesContext>
		</I18nProvider>,
	);
	return setAdvisorProfile;
}

function row(name: string): HTMLElement {
	const label = screen.getAllByText(name).find((el) => el.closest(".adv-machine-key") !== null);
	if (label === undefined) throw new Error(`no row for ${name}`);
	return label.closest(".adv-machine-key") as HTMLElement;
}

function accountRow(): HTMLElement {
	return document.querySelector('[data-id="advisor-account-key"]') as HTMLElement;
}

describe("the account's TypeSafe key", () => {
	it("is pasted once and reaches every other machine sealed: the page sends the key to one machine only and relays bytes that never hold it", async () => {
		const a = await addMachine("Mac A");
		const b = await addMachine("Mac B");
		const c = await addMachine("Mac C");
		c.key = { value: "ts_live_own_key_of_machine_c_0123456789", source: "own", setAt: T0, setBy: "local" };
		profile = { ...profile, keyRemovedAt: T0 + 5 };
		open();
		await screen.findByText(t.key.own(fingerprintOf(c.key.value)), undefined, WAIT);
		await waitFor(() => expect(within(row("Mac A")).getByText(t.key.noKey)).toBeTruthy(), WAIT);

		await userEvent.click(within(accountRow()).getByRole("button", { name: t.key.paste }));
		const field = within(accountRow()).getByLabelText(t.key.field) as HTMLInputElement;
		expect(field.type).toBe("password");
		await userEvent.type(field, KEY);
		await userEvent.click(within(accountRow()).getByRole("button", { name: t.key.save }));
		// The field empties at once: the page keeps no copy.
		expect(field.value).toBe("");

		await waitFor(() => expect(b.key?.value).toBe(KEY), WAIT);
		// The plain key went to exactly one machine, as the account's, after the last removal.
		const sets = machines.flatMap((m) => m.machine.sent("advisorSetKey"));
		expect(sets).toHaveLength(1);
		expect(a.machine.sent("advisorSetKey")[0]).toMatchObject({ key: KEY, source: AdvisorKeySource.ACCOUNT });
		expect(Number(a.machine.sent("advisorSetKey")[0]?.setAt)).toBeGreaterThan(T0 + 5);
		// B got it handed on: a ticket, then the bytes A sealed, relayed as they were.
		expect(b.machine.sent("advisorKeyShareBegin")).toHaveLength(1);
		const sealed = a.machine.sent("advisorKeySeal");
		expect(sealed).toHaveLength(1);
		expect(b.machine.sent("advisorKeyShareOpen")).toHaveLength(1);
		expect(b.key).toMatchObject({ source: "account", setAt: a.key?.setAt });
		const key = utf8(KEY);
		expect(containsBytes(b.receivedBytes(), key)).toBe(false);
		expect(containsBytes(c.receivedBytes(), key)).toBe(false);
		// C keeps its own key and is never asked to take or give the account's.
		expect(c.key?.source).toBe("own");
		expect(c.machine.sent("advisorKeyShareBegin")).toHaveLength(0);
		expect(c.machine.sent("advisorKeySeal")).toHaveLength(0);
		await waitFor(() => expect(toasts).toContain(viMachines.advisorKeySynced("Mac B")), WAIT);
		expect(await within(row("Mac B")).findByText(t.key.usingAccount(fingerprintOf(KEY)), undefined, WAIT)).toBeTruthy();
		expect(within(accountRow()).getByText(t.key.account.set(fingerprintOf(KEY)))).toBeTruthy();
		// Nothing the page stores holds the key.
		const stored = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage });
		expect(stored).not.toContain(KEY);
	});

	it("keeps a machine's own key, which is pasted and removed for that machine only", async () => {
		const a = await addMachine("Mac A");
		open();
		const card = await within(document.body).findByText(t.key.noKey, undefined, WAIT);
		const r = card.closest(".adv-machine-key") as HTMLElement;
		await userEvent.click(within(r).getByRole("button", { name: t.key.pasteOwn }));
		await userEvent.type(within(r).getByLabelText(t.key.field), KEY);
		await userEvent.click(within(r).getByRole("button", { name: t.key.save }));
		await waitFor(() => expect(a.key).toMatchObject({ value: KEY, source: "own" }), WAIT);
		expect(a.machine.sent("advisorSetKey")[0]?.source).toBe(AdvisorKeySource.OWN);
		expect(await within(r).findByText(t.key.own(fingerprintOf(KEY)), undefined, WAIT)).toBeTruthy();
		await userEvent.click(within(r).getByRole("button", { name: t.key.removeOwn }));
		await userEvent.click(within(r).getAllByRole("button", { name: t.key.removeOwn }).at(-1) as HTMLElement);
		await waitFor(() => expect(a.key).toBeNull(), WAIT);
		expect(a.machine.sent("advisorRemoveKey")[0]?.source).toBe(AdvisorKeySource.OWN);
	});

	it("offers a machine's key kept from before as the account's; agreeing promotes it and hands it on", async () => {
		const a = await addMachine("Mac A");
		const b = await addMachine("Mac B");
		a.key = { value: KEY, source: "own", setAt: T0, setBy: "local" };
		open();
		const bar = await screen.findByText(t.key.account.promote("Mac A"), undefined, WAIT);
		// Nothing is handed on before the user agrees.
		expect(b.machine.sent("advisorKeyShareBegin")).toHaveLength(0);
		await userEvent.click(within(bar.closest(".adv-machine-key") as HTMLElement).getByRole("button", { name: t.key.account.promoteYes }));
		await waitFor(() => expect(b.key).toMatchObject({ value: KEY, source: "account" }), WAIT);
		expect(a.machine.sent("advisorKeyPromote")).toHaveLength(1);
		expect(a.key?.source).toBe("account");
		await waitFor(() => expect(screen.queryByText(t.key.account.promote("Mac A"))).toBeNull(), WAIT);
	});

	it("removes the account's key from every machine and keeps the time it was removed", async () => {
		const a = await addMachine("Mac A");
		const b = await addMachine("Mac B");
		a.key = { value: KEY, source: "account", setAt: T0, setBy: "Chrome" };
		b.key = { value: KEY, source: "account", setAt: T0, setBy: "Chrome" };
		const save = open();
		await within(document.body).findByText(t.key.account.set(fingerprintOf(KEY)), undefined, WAIT);
		await userEvent.click(within(accountRow()).getByRole("button", { name: t.key.remove }));
		await userEvent.click(within(accountRow()).getAllByRole("button", { name: t.key.remove }).at(-1) as HTMLElement);
		await waitFor(() => expect(a.key === null && b.key === null).toBe(true), WAIT);
		expect(save).toHaveBeenCalledTimes(1);
		expect(save.mock.calls[0]?.[0].keyRemovedAt).toBeGreaterThanOrEqual(T0);
		expect(a.machine.sent("advisorRemoveKey")[0]?.source).toBe(AdvisorKeySource.ACCOUNT);
	});

	it("a machine seen after the removal loses its old account key, and that key is never handed on again", async () => {
		const stale = await addMachine("Mac Old");
		const fresh = await addMachine("Mac New");
		stale.key = { value: KEY, source: "account", setAt: T0, setBy: "Chrome" };
		profile = { ...profile, keyRemovedAt: T0 + 1 };
		open();
		await waitFor(() => expect(stale.key).toBeNull(), WAIT);
		expect(stale.machine.sent("advisorRemoveKey")[0]?.source).toBe(AdvisorKeySource.ACCOUNT);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(stale.machine.sent("advisorKeySeal")).toHaveLength(0);
		expect(fresh.machine.sent("advisorKeyShareBegin")).toHaveLength(0);
		expect(fresh.key).toBeNull();
		// The removed key is not offered for promotion either.
		expect(screen.queryByText(t.key.account.promote("Mac Old"))).toBeNull();
	});

	it("removes the account's key while every machine holding it is off: the removal time is kept for when they come back", async () => {
		const b = await addMachine("Mac B");
		const save = open();
		await within(document.body).findByText(t.key.account.none, undefined, WAIT);
		await waitFor(() => row("Mac B"), WAIT);
		const before = Date.now();
		await userEvent.click(within(accountRow()).getByRole("button", { name: t.key.remove }));
		await userEvent.click(within(accountRow()).getAllByRole("button", { name: t.key.remove }).at(-1) as HTMLElement);
		await waitFor(() => expect(save).toHaveBeenCalledTimes(1), WAIT);
		expect(save.mock.calls[0]?.[0].keyRemovedAt).toBeGreaterThanOrEqual(before);
		expect(b.machine.sent("advisorRemoveKey")).toHaveLength(0);
	});

	it("asks no machine to remove the key when the removal time could not be saved", async () => {
		const a = await addMachine("Mac A");
		a.key = { value: KEY, source: "account", setAt: T0, setBy: "Chrome" };
		const save = open(async () => {
			throw new Error("offline");
		});
		await within(document.body).findByText(t.key.account.set(fingerprintOf(KEY)), undefined, WAIT);
		await userEvent.click(within(accountRow()).getByRole("button", { name: t.key.remove }));
		await userEvent.click(within(accountRow()).getAllByRole("button", { name: t.key.remove }).at(-1) as HTMLElement);
		await waitFor(() => expect(save).toHaveBeenCalledTimes(1), WAIT);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(a.machine.sent("advisorRemoveKey")).toHaveLength(0);
		expect(a.key).toMatchObject({ value: KEY, source: "account" });
	});

	it("a machine holding the same account key, counted as set a little earlier, is not handed it again", async () => {
		const a = await addMachine("Mac A");
		const b = await addMachine("Mac B");
		a.key = { value: KEY, source: "account", setAt: T0 + 5, setBy: "Chrome" };
		b.key = { value: KEY, source: "account", setAt: T0, setBy: "Chrome" };
		open();
		await waitFor(() => row("Mac B"), WAIT);
		await within(document.body).findByText(t.key.account.set(fingerprintOf(KEY)), undefined, WAIT);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(b.machine.sent("advisorKeyShareBegin")).toHaveLength(0);
		expect(a.machine.sent("advisorKeySeal")).toHaveLength(0);
	});

	it("putting off the offer to use a machine's key as the account's lasts past a reload, and the machine's row still offers it", async () => {
		const a = await addMachine("Mac A");
		const b = await addMachine("Mac B");
		a.key = { value: KEY, source: "own", setAt: T0, setBy: "local" };
		open();
		const bar = await screen.findByText(t.key.account.promote("Mac A"), undefined, WAIT);
		await userEvent.click(within(bar.closest(".adv-machine-key") as HTMLElement).getByRole("button", { name: t.key.account.later }));
		expect(screen.queryByText(t.key.account.promote("Mac A"))).toBeNull();
		cleanup();
		open();
		await waitFor(() => row("Mac A"), WAIT);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(screen.queryByText(t.key.account.promote("Mac A"))).toBeNull();
		expect(a.machine.sent("advisorKeyPromote")).toHaveLength(0);
		// Only the machine with the key offers it; agreeing there promotes it and hands it on.
		expect(within(row("Mac B")).queryByRole("button", { name: t.key.account.promoteYes })).toBeNull();
		await userEvent.click(within(row("Mac A")).getByRole("button", { name: t.key.account.promoteYes }));
		await waitFor(() => expect(b.key).toMatchObject({ value: KEY, source: "account" }), WAIT);
		expect(a.machine.sent("advisorKeyPromote")).toHaveLength(1);
		await waitFor(() => expect(within(row("Mac A")).queryByRole("button", { name: t.key.account.promoteYes })).toBeNull(), WAIT);
	});

	it("with a profile from an older core (no removal time) nothing about the account's key is offered or synced, and the page says to reopen Chat", async () => {
		const a = await addMachine("Mac A");
		const b = await addMachine("Mac B");
		a.key = { value: KEY, source: "account", setAt: T0, setBy: "Chrome" };
		const { keyRemovedAt: _dropped, ...older } = profile;
		profile = older as AdvisorProfile;
		open();
		expect(await screen.findByText(t.key.account.staleTab, undefined, WAIT)).toBeTruthy();
		await waitFor(() => row("Mac B"), WAIT);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(within(accountRow()).queryByRole("button", { name: t.key.paste })).toBeNull();
		expect(within(accountRow()).queryByRole("button", { name: t.key.remove })).toBeNull();
		expect(b.machine.sent("advisorKeyShareBegin")).toHaveLength(0);
		expect(a.machine.sent("advisorKeySeal")).toHaveLength(0);
	});

	it("a machine on an older tunelo keeps its one key, says it needs a newer tunelo and is never asked to share", async () => {
		const a = await addMachine("Mac A");
		const old = await addMachine("Mac Old");
		old.share = false;
		old.key = { value: "ts_live_old_tunelo_key_0123456789abcdef", source: "own", setAt: T0, setBy: "local" };
		a.key = { value: KEY, source: "account", setAt: T0, setBy: "Chrome" };
		open();
		const r = await waitFor(() => row("Mac Old"), WAIT);
		expect(await within(r).findByText(t.key.needsShare, undefined, WAIT)).toBeTruthy();
		expect(within(r).getByText(t.key.keySet(fingerprintOf("ts_live_old_tunelo_key_0123456789abcdef")))).toBeTruthy();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(old.machine.sent("advisorKeyShareBegin")).toHaveLength(0);
		expect(old.machine.sent("advisorKeySeal")).toHaveLength(0);
	});
});
