// "Tài khoản AI" of one machine (/ai/<machine>/accounts): one block per AI the
// machine reports with the `accounts` capability, one under the other, each
// with its own accounts and actions (provider-accounts-section.tsx). The
// list comes once for every AI: as the machine announces it (MachineAccounts),
// else asked once. An AI without the capability has no block.
import type { ProviderInfo } from "@achoo254/chat-proto/remote/remote";
import { paths } from "../../router.tsx";
import { LinkBanner } from "../link-banner.tsx";
import { profilesOf, useAccountList, type AccountList } from "../machine-profile.ts";
import { PageHead } from "../page-head.tsx";
import { useEntry, useHub, useLink } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import type { MachineLink } from "../link/machine-link.ts";
import { ProviderAccountsSection } from "./provider-accounts-section.tsx";

/** The AIs of the machine that keep several accounts, in the machine's order. */
export function accountProviders(providers: readonly ProviderInfo[]): ProviderInfo[] {
	return providers.filter((p) => p.capabilities?.accounts === true);
}

export interface AiAccountsViewProps {
	link: MachineLink;
	online: boolean;
	/** The AIs the machine reports (MachineInfo.providers); empty while unknown. */
	providers: readonly ProviderInfo[];
	/** True once the machine said what it runs (MachineInfo arrived). */
	known: boolean;
	accounts: AccountList;
}

/** The blocks of every AI with accounts, or why there are none. */
export function AiAccountsView({ link, online, providers, known, accounts }: AiAccountsViewProps) {
	const t = useMachinesCopy();
	const a = t.aiAccounts;
	const ais = accountProviders(providers);
	return (
		<>
			<p className="note">{a.note}</p>
			{!online && <p className="muted">{a.needsLink}</p>}
			{online && known && ais.length === 0 && <p className="muted">{a.none}</p>}
			{ais.map((p) => (
				<ProviderAccountsSection key={p.id} link={link} online={online} ai={p.name || p.id} profiles={profilesOf(accounts, p.id)} />
			))}
		</>
	);
}

export default function AiAccountsScreen({ machine }: { machine: string }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const entry = useEntry(hub, machine);
	const [link, state] = useLink(hub, machine);
	const online = state.status.kind === "open";
	const providers = state.info?.providers ?? [];
	const accounts = useAccountList(link, state.machineAccounts, online, accountProviders(providers).length > 0);
	const name = entry?.name ?? state.info?.name ?? "";
	return (
		<div className="mx-scroll" role="region" aria-label={t.aiAccounts.title} data-id="ai-accounts">
			<PageHead back={paths.machineInfo(machine)} backLabel={t.agent.info} title={t.aiAccounts.title} subtitle={name === "" ? undefined : t.aiAccounts.subtitle(name)} />
			<LinkBanner machine={machine} name={name} status={state.status} />
			<div className="mx-body">
				{entry === null && hub.directory().status !== "loading" ? (
					<p className="muted">{t.notFound}</p>
				) : (
					<AiAccountsView link={link} online={online} providers={providers} known={state.info !== null} accounts={accounts} />
				)}
			</div>
		</div>
	);
}
