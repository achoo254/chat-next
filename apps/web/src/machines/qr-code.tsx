// A QR code drawn as SVG in the page: uqr computes the modules here, so the
// text never becomes an image file, a data URI or a request. Dark modules on
// a light square whatever the theme, with the 4-module quiet zone scanners
// expect (machines.css .mx-qr).
import type { ReactElement } from "react";
import { encode } from "uqr";

const QUIET_ZONE = 4;

export function QrCode({ text, label }: { text: string; label: string }): ReactElement {
	const qr = encode(text, { ecc: "M", border: QUIET_ZONE });
	let path = "";
	qr.data.forEach((row, y) => {
		row.forEach((dark, x) => {
			if (dark) path += `M${x} ${y}h1v1h-1z`;
		});
	});
	return (
		<svg className="mx-qr" role="img" aria-label={label} viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges">
			<path d={path} fill="currentColor" />
		</svg>
	);
}
