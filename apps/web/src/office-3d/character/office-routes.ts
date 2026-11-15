// How a person walks from one place of the building to another: along the
// walkway graph of their floor (shortest by distance, through the doors the
// graph's door nodes sit in), and between floors by the elevator (walk to the
// floor's elevator node, ride, walk on from the elevator node of the other
// floor). The elevator has no capacity in this logic: people ride through
// each other; only the travel time counts. Pure, no engine.
import type { OfficeLayout } from "../../machines/office/office-layout.ts";
import type { FloorLevel } from "../../machines/office/office-rooms.ts";

/** A point of a route; `node` names the graph node it stands on, null for an anchor's own spot. */
export interface RoutePoint {
	readonly x: number;
	readonly z: number;
	readonly node: string | null;
}

export type Leg =
	| { readonly kind: "walk"; readonly floor: FloorLevel; readonly points: readonly RoutePoint[] }
	| { readonly kind: "lift"; readonly from: FloorLevel; readonly to: FloorLevel; readonly seconds: number; readonly x: number; readonly z: number };

export interface Route {
	readonly legs: readonly Leg[];
}

/** Where a walk starts or ends: a point on a floor and the graph node it joins the walkways at. */
export interface Spot {
	readonly floor: FloorLevel;
	readonly x: number;
	readonly z: number;
	readonly node: string;
}

interface FloorGraph {
	readonly nodes: ReadonlyMap<string, { readonly x: number; readonly z: number }>;
	readonly links: ReadonlyMap<string, readonly string[]>;
	readonly elevator: string;
}

export interface Router {
	route(from: Spot, to: Spot): Route;
	/** The node position on a floor (null if the floor has no such node). */
	nodeAt(floor: FloorLevel, node: string): { readonly x: number; readonly z: number } | null;
}

function graphOf(floor: OfficeLayout["floors"][number]): FloorGraph {
	const nodes = new Map(floor.graph.nodes.map((n) => [n.id, { x: n.x, z: n.z }]));
	const links = new Map<string, string[]>(floor.graph.nodes.map((n) => [n.id, []]));
	for (const [a, b] of floor.graph.edges) {
		links.get(a)?.push(b);
		links.get(b)?.push(a);
	}
	return { nodes, links, elevator: floor.elevatorNode };
}

/** Shortest node path by distance (Dijkstra; the graphs have a few dozen nodes). Empty when unreachable. */
function shortestPath(graph: FloorGraph, from: string, to: string): string[] {
	if (!graph.nodes.has(from) || !graph.nodes.has(to)) return [];
	if (from === to) return [from];
	const dist = new Map<string, number>([[from, 0]]);
	const prev = new Map<string, string>();
	const open = new Set<string>([from]);
	while (open.size > 0) {
		let current: string | null = null;
		for (const id of open) if (current === null || (dist.get(id) ?? Infinity) < (dist.get(current) ?? Infinity)) current = id;
		if (current === null || current === to) break;
		open.delete(current);
		const here = graph.nodes.get(current);
		if (here === undefined) continue;
		for (const next of graph.links.get(current) ?? []) {
			const there = graph.nodes.get(next);
			if (there === undefined) continue;
			const d = (dist.get(current) ?? Infinity) + Math.hypot(there.x - here.x, there.z - here.z);
			if (d < (dist.get(next) ?? Infinity)) {
				dist.set(next, d);
				prev.set(next, current);
				open.add(next);
			}
		}
	}
	if (!prev.has(to)) return [];
	const path = [to];
	for (let id = prev.get(to); id !== undefined; id = prev.get(id)) path.unshift(id);
	return path;
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

export function createRouter(layout: OfficeLayout, doorSeconds: number): Router {
	const graphs = new Map<FloorLevel, FloorGraph>(layout.floors.map((f) => [f.level, graphOf(f)]));
	const nodePoints = (graph: FloorGraph, ids: readonly string[]): RoutePoint[] =>
		ids.flatMap((id) => {
			const n = graph.nodes.get(id);
			return n === undefined ? [] : [{ x: n.x, z: n.z, node: id }];
		});
	const walk = (floor: FloorLevel, from: { x: number; z: number; node: string | null }, viaFrom: string, viaTo: string, to: { x: number; z: number; node: string | null }): Leg => {
		const graph = graphs.get(floor);
		const ids = graph === undefined ? [] : shortestPath(graph, viaFrom, viaTo);
		return { kind: "walk", floor, points: tidy([from, ...(graph === undefined ? [] : nodePoints(graph, ids)), to]) };
	};
	return {
		route(from, to) {
			const start = { x: from.x, z: from.z, node: null };
			const end = { x: to.x, z: to.z, node: null };
			if (from.floor === to.floor) {
				// Two places joining the walkways at one node: straight across (same room).
				if (from.node === to.node) return { legs: [{ kind: "walk", floor: from.floor, points: tidy([start, end]) }] };
				return { legs: [walk(from.floor, start, from.node, to.node, end)] };
			}
			const a = graphs.get(from.floor);
			const b = graphs.get(to.floor);
			const liftA = a?.nodes.get(a.elevator);
			const liftB = b?.nodes.get(b.elevator);
			if (a === undefined || b === undefined || liftA === undefined || liftB === undefined) return { legs: [] };
			const floors = Math.abs(to.floor - from.floor);
			return {
				legs: [
					walk(from.floor, start, from.node, a.elevator, { ...liftA, node: a.elevator }),
					{ kind: "lift", from: from.floor, to: to.floor, seconds: floors * layout.elevator.travelSecondsPerFloor + doorSeconds, x: liftB.x, z: liftB.z },
					walk(to.floor, { ...liftB, node: b.elevator }, b.elevator, to.node, end),
				],
			};
		},
		nodeAt(floor, node) {
			return graphs.get(floor)?.nodes.get(node) ?? null;
		},
	};
}
