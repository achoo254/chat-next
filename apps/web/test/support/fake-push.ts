// In-memory PushService for tests: one registration per signed-in session
// (the fake has a single session), and a key that turns Web Push off when
// emptied. Never imported by production code.
import type { ConnectRouter } from "@connectrpc/connect";
import { PushService } from "@app/proto-ts/push";

export interface FakeRegistration {
	readonly endpoint: string;
	readonly p256dh: Uint8Array;
	readonly auth: Uint8Array;
	readonly locale: string;
}

/** A 65-byte stand-in for the server's VAPID public key. */
export const FAKE_PUSH_KEY = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : i));

export class FakePush {
	/** Empty: the server has Web Push off. */
	key: Uint8Array = FAKE_PUSH_KEY;
	registration: FakeRegistration | null = null;

	routes(router: ConnectRouter): void {
		router.service(PushService, {
			getWebPushConfig: () => ({ applicationServerKey: this.key, endpoint: this.registration?.endpoint ?? "" }),
			registerWebPush: (req) => {
				this.registration = {
					endpoint: req.endpoint,
					p256dh: req.p256dh,
					auth: req.auth,
					locale: req.locale === "" ? (this.registration?.locale ?? "vi") : req.locale,
				};
				return {};
			},
			unregisterWebPush: () => {
				this.registration = null;
				return {};
			},
		});
	}
}
