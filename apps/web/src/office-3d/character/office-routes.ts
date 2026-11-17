// How a person walks from one place of the office to another: along the
// walkway graph of the plan (shortest by distance, through the doors the
// graph's door nodes sit in and the corridors between the zones). The graph
// and its search are office-walkways.ts, shared with the layout check, so a
// route here is a walk the check measured. Pure, no engine.
import type { OfficeLayout } from "../../machines/office/office-layout.ts";
import { buildWalkGraph } from "../../machines/office/office-walkways.ts";

/** A point of a route; `node` names the graph node it stands on, null for an anchor's own spot. */
export interface RoutePoint {
	readonly x: number;
	readonly z: number;
	readonly node: string | null;
}

export interface Leg {
	readonly kind: "walk";
	readonly points: readonly RoutePoint[];
}

export interface Route {
	readonly legs: readonly Leg[];
}

/** Where a walk starts or ends: a point of the plan and the graph node it joins the walkways at. */
export interface Spot {
	readonly x: number;
	readonly z: number;
	readonly node: string;
}

export interface Router {
	route(from: Spot, to: Spot): Route;
	/** The node's position (null if the plan has no such node). */
	nodeAt(node: string): { readonly x: number; readonly z: number } | null;
}

/** Drops points that repeat the one before (a spot standing on its own node). */
function tidy(points: readonly RoutePoint[]): RoutePoint[] {
	const out: RoutePoint[] = [];
	for (const p of points) {
		const last = out[out.length - 1];
		if (last !== undefined && Math.hypot(last.x - p.x, last.z - p.z) < 1e-3) {
			if (last.node === null && p.node !== null) out[out.length - 1] = p;
			continue;
		}
		out.push(p);
	}
	return out;
}

export function createRouter(layout: OfficeLayout): Router {
	const graph = buildWalkGraph(layout.graph);
	const nodePoints = (ids: readonly string[]): RoutePoint[] =>
		ids.flatMap((id) => {
			const n = graph.nodes.get(id);
			return n === undefined ? [] : [{ x: n.x, z: n.z, node: id }];
		});
	return {
		route(from, to) {
			const start = { x: from.x, z: from.z, node: null };
			const end = { x: to.x, z: to.z, node: null };
			// Two places joining the walkways at one node: straight across (same room).
			if (from.node === to.node) return { legs: [{ kind: "walk", points: tidy([start, end]) }] };
			return { legs: [{ kind: "walk", points: tidy([start, ...nodePoints(graph.shortestPath(from.node, to.node)), end]) }] };
		},
		nodeAt(node) {
			return graph.nodes.get(node) ?? null;
		},
	};
}
