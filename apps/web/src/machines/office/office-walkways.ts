// The walkway graph of the plan as a pure structure: reachability, shortest
// paths by distance and the longest walk between two places. The layout check
// (office-layout.ts) and the 3D router (office-3d/character/office-routes.ts)
// share it, so a path the check accepts is the path a person walks.

interface WalkNode {
	readonly x: number;
	readonly z: number;
}

export interface WalkGraph {
	readonly nodes: ReadonlyMap<string, WalkNode>;
	readonly links: ReadonlyMap<string, readonly string[]>;
	/** Every node reachable from `from` (including it), or none when `from` is not a node. */
	reachable(from: string): ReadonlySet<string>;
	/** Node path from `from` to `to` by distance; `[from]` when equal, empty when unreachable. */
	shortestPath(from: string, to: string): string[];
	/** Walking distance from `from` to every node reachable from it, metres. */
	distances(from: string): ReadonlyMap<string, number>;
}

export function buildWalkGraph(graph: { readonly nodes: readonly { readonly id: string; readonly x: number; readonly z: number }[]; readonly edges: readonly (readonly [string, string])[] }): WalkGraph {
	const nodes = new Map<string, WalkNode>(graph.nodes.map((n) => [n.id, { x: n.x, z: n.z }]));
	const links = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
	for (const [a, b] of graph.edges) {
		links.get(a)?.push(b);
		links.get(b)?.push(a);
	}
	const length = (a: string, b: string): number => {
		const p = nodes.get(a);
		const q = nodes.get(b);
		return p === undefined || q === undefined ? Infinity : Math.hypot(p.x - q.x, p.z - q.z);
	};
	/** Dijkstra from `from`; the graphs have a few dozen nodes, so the open set is scanned. */
	const search = (from: string, to: string | null): { dist: Map<string, number>; prev: Map<string, string> } => {
		const dist = new Map<string, number>();
		const prev = new Map<string, string>();
		if (!nodes.has(from)) return { dist, prev };
		dist.set(from, 0);
		const open = new Set<string>([from]);
		while (open.size > 0) {
			let current: string | null = null;
			for (const id of open) if (current === null || (dist.get(id) ?? Infinity) < (dist.get(current) ?? Infinity)) current = id;
			if (current === null || current === to) break;
			open.delete(current);
			for (const next of links.get(current) ?? []) {
				const d = (dist.get(current) ?? Infinity) + length(current, next);
				if (d < (dist.get(next) ?? Infinity)) {
					dist.set(next, d);
					prev.set(next, current);
					open.add(next);
				}
			}
		}
		return { dist, prev };
	};
	return {
		nodes,
		links,
		reachable: (from) => new Set(search(from, null).dist.keys()),
		distances: (from) => search(from, null).dist,
		shortestPath(from, to) {
			if (!nodes.has(from) || !nodes.has(to)) return [];
			if (from === to) return [from];
			const { prev } = search(from, to);
			if (!prev.has(to)) return [];
			const path = [to];
			for (let id = prev.get(to); id !== undefined; id = prev.get(id)) path.unshift(id);
			return path;
		},
	};
}

/** The longest shortest walk between two of `nodeIds`. */
export function longestWalk(graph: WalkGraph, nodeIds: readonly string[]): { readonly metres: number; readonly from: string; readonly to: string } {
	let best = { metres: 0, from: "", to: "" };
	for (const from of nodeIds) {
		const dist = graph.distances(from);
		for (const to of nodeIds) {
			const metres = dist.get(to) ?? Infinity;
			if (metres > best.metres) best = { metres, from, to };
		}
	}
	return best;
}
