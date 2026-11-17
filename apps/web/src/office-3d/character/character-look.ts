// How one drawn person looks on top of the shared character model: the skin
// cell of the atlas (the director always wears the concept skin, cell 0;
// everyone else gets a cell from a hash of their stable key, so an employee
// keeps one look across sessions and reloads) and the accessory their agent
// type carries (office-cast.ts), by the asset file's accessory names. Advisor
// wears the skin and accessory of its look (the user's Advisor profile): the
// first of its skin names the atlas has, and its accessory when the asset file
// has a model for it (none otherwise: nothing stands in for it). Pure, no
// engine.
import type { LookId } from "../../advisor/looks.ts";
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
	/** Times the accessory's own scale (Advisor's glasses are bigger than an employee's). */
	readonly accessoryScale: number;
	/** Skin names of the atlas to wear, the first one it has wins; empty: a cell by the key. */
	readonly skins: readonly string[];
}

/**
 * Advisor's dress per look. Skins: the look's own cell once the atlas has it
 * ("advisor-<look>", made with the character's other skins), else the existing
 * cell nearest the look's main colour (owl brown-grey, robot steel blue, suit
 * navy, cat orange). Accessories by the asset file's names: the owl wears the
 * staff's glasses made larger, the others their own accessory once it is
 * packed into the accessories GLB (until then, nothing).
 */
export const ADVISOR_DRESS: Readonly<Record<LookId, { readonly skins: readonly string[]; readonly accessory: string; readonly accessoryScale: number }>> = {
	owl: { skins: ["advisor-owl", "grey-red-hair"], accessory: "glasses", accessoryScale: 1.1 },
	robot: { skins: ["advisor-robot", "teal-overalls"], accessory: "advisor-antenna-band", accessoryScale: 1 },
	suit: { skins: ["advisor-suit", "rose-shirt"], accessory: "advisor-chart-tablet", accessoryScale: 1 },
	cat: { skins: ["advisor-cat", "mustard"], accessory: "advisor-cat-ears", accessoryScale: 1 },
};

function isLookId(id: string): id is LookId {
	return id in ADVISOR_DRESS;
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

export function personLook(p: Pick<Placement, "key" | "kind" | "actor" | "member"> & Partial<Pick<Placement, "advisor">>): PersonLook {
	if (p.kind === "advisor") {
		const id = p.advisor?.lookId ?? "";
		// An unknown look (a newer app's) dresses as the first one, as the mascot shows it.
		const dress = ADVISOR_DRESS[isLookId(id) ? id : "owl"];
		return { color: personColor(p), kind: p.kind, key: p.key, accessory: dress.accessory, accessoryScale: dress.accessoryScale, skins: dress.skins };
	}
	const type = p.member?.agentType ?? p.actor?.agentType ?? "";
	const accessory = p.kind === "employee" ? ACCESSORY_ITEMS[castOf(type).accessory] : null;
	return { color: personColor(p), kind: p.kind, key: p.key, accessory, accessoryScale: 1, skins: [] };
}

/**
 * What the drawn body depends on (colour, skins, accessory and its size): a
 * person whose dress key changes is drawn again (Advisor once the viewer's
 * profile, read late or changed, names another look).
 */
export function dressKey(look: PersonLook): string {
	return [look.kind, look.color, look.skins.join("+"), look.accessory ?? "", look.accessoryScale].join("|");
}

/**
 * The atlas cell for a person among `count` skins named `names` (the atlas's
 * order): the first of the look's skins the atlas has; else 0 for the
 * director, a stable hashed cell from 1 up for the rest.
 */
export function skinCellFor(look: Pick<PersonLook, "kind" | "key"> & Partial<Pick<PersonLook, "skins">>, count: number, names: readonly string[] = []): number {
	for (const skin of look.skins ?? []) {
		const cell = names.indexOf(skin);
		if (cell >= 0 && cell < count) return cell;
	}
	if (count <= 1 || look.kind === "director") return 0;
	return 1 + (nameHash(look.key) % (count - 1));
}
