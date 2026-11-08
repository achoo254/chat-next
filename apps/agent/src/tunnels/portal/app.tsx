/** Root app component — router with public + protected routes */

import { useEffect } from "react";
import {
	BrowserRouter,
	Navigate,
	Route,
	Routes,
	useLocation,
	useNavigate,
} from "react-router-dom";
import { NavBar } from "./components/nav-bar.js";
import { useAuth } from "./hooks/use-auth.js";
import { DeviceAuthPage } from "./pages/device-auth-page.js";
import { KeysPage } from "./pages/keys-page.js";
import { LoginPage } from "./pages/login-page.js";
import { ProfilePage } from "./pages/profile-page.js";
import { SignupPage } from "./pages/signup-page.js";
import { UsagePage } from "./pages/usage-page.js";

const PUBLIC_PATHS = new Set(["/login", "/signup", "/auth/device"]);

/** Redirect to /login if not authenticated on protected routes */
function AuthGuard({
	children,
}: { children: React.ReactNode }): React.ReactElement {
	const { user, loading, fetchMe } = useAuth();
	const location = useLocation();
	const navigate = useNavigate();

	useEffect(() => {
		if (!user && !loading) {
			void fetchMe().catch(() => {
				if (!PUBLIC_PATHS.has(location.pathname)) {
					const currentUrl = location.pathname + location.search;
					navigate(`/login?next=${encodeURIComponent(currentUrl)}`, {
						replace: true,
					});
				}
			});
		}
	}, [user, loading, fetchMe, location.pathname, location.search, navigate]);

	return <>{children}</>;
}

function ProtectedLayout({
	children,
}: { children: React.ReactNode }): React.ReactElement {
	return (
		<div className="min-h-screen bg-gray-50">
			<NavBar />
			<main>{children}</main>
		</div>
	);
}

export function App(): React.ReactElement {
	return (
		<BrowserRouter>
			<AuthGuard>
				<Routes>
					{/* Public routes */}
					<Route path="/signup" element={<SignupPage />} />
					<Route path="/login" element={<LoginPage />} />
					<Route path="/auth/device" element={<DeviceAuthPage />} />

					{/* Protected routes */}
					<Route
						path="/keys"
						element={
							<ProtectedLayout>
								<KeysPage />
							</ProtectedLayout>
						}
					/>
					<Route
						path="/usage"
						element={
							<ProtectedLayout>
								<UsagePage />
							</ProtectedLayout>
						}
					/>
					<Route
						path="/profile"
						element={
							<ProtectedLayout>
								<ProfilePage />
							</ProtectedLayout>
						}
					/>

					{/* Default redirect */}
					<Route path="/" element={<Navigate to="/keys" replace />} />
					<Route path="*" element={<Navigate to="/keys" replace />} />
				</Routes>
			</AuthGuard>
		</BrowserRouter>
	);
}
