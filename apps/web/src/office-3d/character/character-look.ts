// How one drawn person looks on top of the shared character model: the skin
// cell of the atlas (the director always wears the concept skin, cell 0;
// everyone else gets a cell from a hash of their stable key, so an employee
// keeps one look across sessions and reloads) and the accessory their agent
// type carries (office-cast.ts), by the asset file's accessory names. Pure,
// no engine.
import type { Accessory } from "../../machines/office/office-cast.ts";
import { castOf, nameHash } from "../../machines/office/office-cast.ts";
import { personColor } from "../../machines/office/office-names.ts";
import type { Placement } from "../../machines/office/office-placement.ts";

export interface PersonLook {
	/** The placeholder block colour (and the 2D colour). */
	readonly color: string;
	readonly kind: Placement["kind"];
	/** Stable key the skin cell is hashed from. */
	readonly key: string;
	/** The accessory item name in the asset file, or null. */
	readonly accessory: string | null;
}

/** Cast accessories by the asset file's item names; null where no model exists for it. */
export const ACCESSORY_ITEMS: Readonly<Record<Accessory, string | null>> = {
	magnifier: "magnifier",
	map: null,
	toolbox: null,
	hardhat: "hard-hat",
	glasses: "glasses",
	books: "book-stack",
	clipboard: "clipboard",
	flashlight: "flashlight",
	none: null,
};

/** The item held while drinking at the pantry. */
export const COFFEE_ITEM = "mug";

export function personLook(p: Pick<Placement, "key" | "kind" | "actor" | "member">): PersonLook {
	const type = p.member?.agentType ?? p.actor?.agentType ?? "";
	const accessory = p.kind === "employee" ? ACCESSORY_ITEMS[castOf(type).accessory] : null;
	return { color: personColor(p), kind: p.kind, key: p.key, accessory };
}

/** The atlas cell for a person among `count` skins: 0 for the director, a stable hashed cell from 1 up for the rest. */
export function skinCellFor(look: Pick<PersonLook, "kind" | "key">, count: number): number {
	if (count <= 1 || look.kind === "director") return 0;
	return 1 + (nameHash(look.key) % (count - 1));
}
