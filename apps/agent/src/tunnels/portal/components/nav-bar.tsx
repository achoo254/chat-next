/** Top navigation bar for the portal — links + logout button */

import { NavLink, useNavigate } from "react-router-dom";
import { apiFetch, clearCsrfToken } from "../api/client.js";

const NAV_LINKS = [
	{ to: "/keys", label: "API Keys" },
	{ to: "/usage", label: "Usage" },
	{ to: "/profile", label: "Profile" },
];

export function NavBar(): React.ReactElement {
	const navigate = useNavigate();

	async function handleLogout(): Promise<void> {
		await apiFetch("/api/auth/logout", { method: "POST" });
		clearCsrfToken();
		navigate("/login");
	}

	return (
		<nav className="bg-gray-900 text-white px-6 py-3 flex items-center justify-between">
			<div className="flex items-center gap-6">
				<span className="font-bold text-lg tracking-tight">Tunelo</span>
				<div className="flex gap-4">
					{NAV_LINKS.map((link) => (
						<NavLink
							key={link.to}
							to={link.to}
							className={({ isActive }) =>
								`text-sm font-medium transition-colors ${
									isActive
										? "text-white underline underline-offset-4"
										: "text-gray-400 hover:text-white"
								}`
							}
						>
							{link.label}
						</NavLink>
					))}
				</div>
			</div>
			<button
				type="button"
				onClick={() => void handleLogout()}
				className="text-sm text-gray-400 hover:text-white transition-colors"
			>
				Logout
			</button>
		</nav>
	);
}
