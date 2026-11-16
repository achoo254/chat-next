// What a signed-in start loads of Advisor: only this loader (messaging-root.tsx
// imports it lazily). The mascot, its store, styles and pictures load from
// here, in chunks of their own, so the startup bundle names one file for
// Advisor instead of all of them.
import { lazy, Suspense } from "react";
import type { Route } from "../router.tsx";

const AdvisorMascot = lazy(() => import("./advisor-mascot.tsx"));

export default function AdvisorLoader({ route }: { route: Route }) {
	return (
		<Suspense fallback={null}>
			<AdvisorMascot route={route} />
		</Suspense>
	);
}
