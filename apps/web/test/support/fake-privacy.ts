// In-memory PrivacyService for tests: one user's exports, built when the
// test says so. Never imported by production code.
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { DataExportStatus, PrivacyService, type DataExport } from "@achoo254/chat-proto/privacy";

const DAY = 24 * 3600;

export class FakePrivacy {
	/** The username in export file names. */
	username = "";
	available = true;
	exports: DataExport[] = [];
	readonly calls: string[] = [];
	readonly urls: number[] = [];

	private now(): number {
		return Math.floor(Date.now() / 1000);
	}

	private latest(): DataExport | undefined {
		return this.exports.at(-1);
	}

	private nextRequestAt(): bigint {
		const last = [...this.exports].reverse().find((e) => e.status !== DataExportStatus.FAILED);
		if (last === undefined) return 0n;
		const next = Number(last.createdAt) + 7 * DAY;
		return next > this.now() ? BigInt(next) : 0n;
	}

	/** The newest export moves on: running at `progress`, or ready. */
	advance(progress: number | "ready"): void {
		const e = this.latest();
		if (e === undefined) throw new Error("no export");
		if (progress === "ready") {
			e.status = DataExportStatus.READY;
			e.progress = 100;
			e.size = 248n << 20n;
			e.readyAt = BigInt(this.now());
			e.expiresAt = BigInt(this.now() + 30 * DAY);
		} else {
			e.status = DataExportStatus.RUNNING;
			e.progress = progress;
		}
	}

	routes(router: ConnectRouter): void {
		router.service(PrivacyService, {
			getDataExport: () => {
				const latest = this.latest();
				return { ...(latest === undefined ? {} : { export: latest }), nextRequestAt: this.nextRequestAt(), available: this.available };
			},
			requestDataExport: () => {
				this.calls.push("RequestDataExport");
				if (!this.available) throw new ConnectError("export_unavailable: off", Code.FailedPrecondition);
				if (this.nextRequestAt() !== 0n) throw new ConnectError("export_rate_limited: one per 7 days", Code.ResourceExhausted);
				const created = BigInt(this.now());
				this.exports.push({
					$typeName: "app.v1.DataExport",
					id: BigInt(this.exports.length + 1),
					status: DataExportStatus.PENDING,
					progress: 0,
					size: 0n,
					fileName: `chat-export-${this.username}-20261016.zip`,
					createdAt: created,
					readyAt: 0n,
					expiresAt: 0n,
				});
				return { export: this.exports.at(-1), nextRequestAt: this.nextRequestAt() };
			},
			getDataExportUrl: (req) => {
				const id = Number(req.exportId);
				this.urls.push(id);
				const e = this.exports.find((x) => Number(x.id) === id);
				if (e === undefined || e.status !== DataExportStatus.READY) throw new ConnectError("export_not_ready", Code.FailedPrecondition);
				return { url: `https://media.example.test/f/export/token-${id}`, expiresAt: BigInt(this.now() + 600) };
			},
		});
	}
}
