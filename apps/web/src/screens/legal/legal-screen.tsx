// Public pages (/privacy, /terms, /delete-account): readable without signing
// in, so app stores and visitors can link to them. The text is legal-copy.ts.
import { useEffect } from "react";
import { brand } from "../../brand.ts";
import { ExternalLink } from "../../components/external-link.tsx";
import { PublicPage } from "../../components/public-chrome.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, paths, type LegalPage } from "../../router.tsx";
import { legalCopy, type LegalLink, type LegalSection } from "./legal-copy.ts";
import "./legal.css";

const PAGES: readonly { page: LegalPage; path: string }[] = [
	{ page: "privacy", path: paths.privacy },
	{ page: "terms", path: paths.terms },
	{ page: "delete-account", path: paths.deleteAccount },
];

export default function LegalScreen({ page }: { page: LegalPage }) {
	const { locale, t } = useI18n();
	const copy = legalCopy[locale];
	const doc = copy.documents[page];

	useEffect(() => {
		const previous = document.title;
		document.title = `${doc.title} · ${brand.appName}`;
		return () => {
			document.title = previous;
		};
	}, [doc.title]);

	// The shell's canonical names the home page; each public page is its own
	// document for search engines, so point it here while this page is open.
	useEffect(() => {
		const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
		const path = PAGES.find((entry) => entry.page === page)?.path;
		if (canonical === null || path === undefined) return;
		const previous = canonical.href;
		canonical.href = new URL(path, previous).href;
		return () => {
			canonical.href = previous;
		};
	}, [page]);

	return (
		<PublicPage className="legal">
			<nav className="legal-nav" aria-label={t.legal.nav}>
				{PAGES.map((entry) => (
					<Link key={entry.page} to={entry.path} current={entry.page === page}>
						{copy.documents[entry.page].title}
					</Link>
				))}
			</nav>
			<article className="legal-main card" aria-labelledby="legal-title">
				<h1 id="legal-title">{doc.title}</h1>
				<p className="legal-updated">{copy.updated}</p>
				<p className="legal-lede">{doc.lede}</p>
				{doc.sections.map((section) => (
					<Section key={section.title} section={section} />
				))}
			</article>
		</PublicPage>
	);
}

function Section({ section }: { section: LegalSection }) {
	const { link } = section;
	return (
		<section className={section.pending === true ? "legal-pending" : undefined}>
			<h2>{section.title}</h2>
			{section.steps !== undefined && (
				<ol>
					{section.steps.map((step) => (
						<li key={step}>{step}</li>
					))}
				</ol>
			)}
			{section.paragraphs?.map((paragraph) => (
				<p key={paragraph}>{paragraph}</p>
			))}
			{section.items !== undefined && (
				<ul>
					{section.items.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
			)}
			{link !== undefined && (
				<p>
					<SectionLink link={link} />
				</p>
			)}
		</section>
	);
}

function SectionLink({ link }: { link: LegalLink }) {
	switch (link.kind) {
		case "site":
			return (
				<ExternalLink href={link.href} className="link">
					{link.label}
				</ExternalLink>
			);
		case "email":
			return (
				<a href={link.href} className="link">
					{link.label}
				</a>
			);
		default:
			return (
				<Link to={link.href} className="link">
					{link.label}
				</Link>
			);
	}
}
