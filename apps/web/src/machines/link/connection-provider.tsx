// Keeps the links to the user's machines alive across screens: the provider
// sits above the screens' LoaderBoundary (messaging-root.tsx), so leaving
// "My machines" for a chat and coming back does not redo the handshakes. It
// only holds a slot: the link code (handshake, crypto, protobuf) loads with
// the machines screens, which put their hub here on first use. The hub is
// disposed (sockets closed) when the signed-in app goes away.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface Hub {
	dispose(): void;
}

/** The slot for the machines screens' link hub. */
export class HubSlot {
	private hub: Hub | null = null;

	/** The hub, made by `create` the first time. */
	get<T extends Hub>(create: () => T): T {
		this.hub ??= create();
		return this.hub as T;
	}

	/** Closes the hub's sockets; screens that mount again start them anew. */
	dispose(): void {
		this.hub?.dispose();
	}
}

const SlotContext = createContext<HubSlot | null>(null);

export function MachineLinksProvider({ children }: { children: ReactNode }) {
	const [slot] = useState(() => new HubSlot());
	useEffect(() => () => slot.dispose(), [slot]);
	return <SlotContext value={slot}>{children}</SlotContext>;
}

export function useHubSlot(): HubSlot {
	const slot = useContext(SlotContext);
	if (slot === null) throw new Error("useHubSlot must be used inside <MachineLinksProvider>");
	return slot;
}
