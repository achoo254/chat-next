// The services a machines screen needs beyond its own links: toasts, and a chat store holding only the
// Advisor profile (not loaded, so no machine is ever switched), which the machine views read.
import { DEFAULT_ADVISOR_PROFILE } from "@achoo254/chat-core";
import type { Services } from "../../src/messaging/data/services.tsx";

export const machinesServices = {
	toasts: { show: () => undefined },
	store: { subscribe: () => () => undefined, advisorProfile: () => DEFAULT_ADVISOR_PROFILE, advisorProfileLoaded: () => false },
} as unknown as Services;
