import type { SelfUser } from "../api/adapters.ts";
import { Icon } from "../components/icon.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { Link, paths } from "../router.tsx";

/** Chat home before messaging ships: disabled search and empty states. */
export function Home({ self }: { self: SelfUser }) {
	const { t } = useI18n();
	return (
		<div className="home">
			<section className="list" aria-label={t.home.list}>
				<div className="list-head">
					<div className="search-field">
						<Icon name="search" small />
						<input
							type="search"
							placeholder={t.home.searchPlaceholder}
							disabled
							aria-label={t.home.search}
							aria-describedby="search-later"
						/>
						<span className="tag-neutral" id="search-later">
							{t.home.searchLater}
						</span>
					</div>
				</div>
				<div className="empty">
					<Icon name="message" />
					<h2>{t.home.emptyTitle}</h2>
					<p>{t.home.emptyBody}</p>
				</div>
			</section>
			<main className="convo">
				<div className="empty">
					<span className="brand-mark" aria-hidden="true">
						<Icon name="message" />
					</span>
					<h1>{t.home.greeting(self.name)}</h1>
					<p>{t.home.mainBody}</p>
					<Link to={paths.settings("profile")} className="btn btn-sm">
						{t.home.openProfile}
					</Link>
				</div>
			</main>
		</div>
	);
}
