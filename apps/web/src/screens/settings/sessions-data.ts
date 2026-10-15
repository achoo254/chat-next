// The sign-in sessions as a resource (components/preload.ts): the settings
// route starts it along with the screen's code; SessionsSettings reads it.
import type { SessionView } from "../../api/adapters.ts";
import type { Api } from "../../api/client.ts";
import { resource, type Resource } from "../../components/preload.ts";

export function sessionsData(api: Api): Resource<SessionView[]> {
	return resource(api, "sessions", () => api.listSessions());
}
