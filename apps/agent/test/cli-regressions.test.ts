// What scripts and the Windows restart loop rely on, through the real CLI:
// `tunelo` alone prints the help (two groups) and exits 0; hidden commands
// still run; `tunelo status` to a program
// (or with --json) prints only the service's JSON, and exits 1 when no
// service runs. tunelo also never passes the npm package's marker on.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { NPM_FORWARD_ENV, dropInheritedMarkers } from "../src/startup-env.ts";
import { buildCliBundle, buildServiceBundle, machineEnv, startService } from "./support/mcp-harness.ts";

const run = promisify(execFile);
let cli = "";
let home = "";
let service: Awaited<ReturnType<typeof startService>>;

async function tunelo(args: string[], dir = home): Promise<{ code: number; stdout: string }> {
	try {
		const { stdout } = await run(process.execPath, [cli, ...args], { env: machineEnv(dir), timeout: 20_000 });
		return { code: 0, stdout };
	} catch (err) {
		const failed = err as { code?: number; stdout?: string };
		return { code: failed.code ?? 1, stdout: failed.stdout ?? "" };
	}
}

beforeAll(async () => {
	cli = await buildCliBundle("cli-regressions");
	home = mkdtempSync(join(tmpdir(), "tunelo-cli-"));
	service = await startService(await buildServiceBundle("cli-regressions"), home);
});

afterAll(async () => {
	await service.stop();
	rmSync(home, { recursive: true, force: true });
});

describe("tunelo CLI", () => {
	test("with no command prints the help and exits 0", async () => {
		const { code, stdout } = await tunelo([]);
		expect(code).toBe(0);
		expect(stdout).toContain("Usage: tunelo");
	});

	test("status to a program, or with --json, is the service's JSON alone", async () => {
		for (const args of [["status"], ["status", "--json"]]) {
			const { code, stdout } = await tunelo(args);
			expect(code).toBe(0);
			expect(JSON.parse(stdout)).toMatchObject({ tunnels: 0 });
		}
	});

	test("status exits 1 with nothing on stdout when no service runs", async () => {
		const empty = mkdtempSync(join(tmpdir(), "tunelo-cli-none-"));
		try {
			mkdirSync(join(empty, "tunelo"), { recursive: true });
			const { code, stdout } = await tunelo(["status"], empty);
			expect(code).toBe(1);
			expect(stdout).toBe("");
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	test("the help shows the machine's and the tunnels' commands only, in two groups", async () => {
		const { code, stdout } = await tunelo(["--help"]);
		expect(code).toBe(0);
		const groups = stdout.split("\n").filter((l) => /^[A-Z][a-z]+:$/.test(l));
		expect(groups).toEqual(["Machine:", "Tunnel:", "Options:"]);
		const listed = stdout
			.split("\n")
			.filter((l) => /^ {2}[a-z]/.test(l))
			.map((l) => l.trim().split(/\s+/)[0]);
		expect(listed).toEqual(["login", "logout", "status", "update", "uninstall", "logs", "http", "tcp", "kill", "watch", "config"]);
		for (const gone of ["install", "devices", "audit", "authenticator", "profiles", "claude", "secrets", "browser", "usage", "link", "links", "whoami", "version", "start", "stop", "run", "mcp", "trust", "disk-access"]) {
			expect(listed).not.toContain(gone);
		}
		const config = await tunelo(["config", "--help"]);
		expect(config.stdout).not.toMatch(/local-forward|mcp-local-writes/);
	});

	test("hidden commands still run; removed ones are unknown", async () => {
		for (const hidden of [["start"], ["stop"], ["run"], ["mcp"], ["trust"], ["untrust"], ["trusted"], ["config", "local-forward"], ["config", "mcp-local-writes"]]) {
			const { code, stdout } = await tunelo([...hidden, "--help"]);
			expect(code).toBe(0);
			expect(stdout).toContain(`Usage: tunelo ${hidden.join(" ")}`);
		}
		expect(["granted", "needed", "not-applicable"]).toContain((await tunelo(["disk-access"])).stdout.trim());
		for (const gone of ["install", "whoami", "version", "devices", "authenticator", "link"]) {
			expect((await tunelo([gone])).code).not.toBe(0);
		}
	});

	test("drops the marker of the npm package from its environment", () => {
		const env: NodeJS.ProcessEnv = { [NPM_FORWARD_ENV]: "1", PATH: "/bin" };
		dropInheritedMarkers(env);
		expect(env).toEqual({ PATH: "/bin" });
	});
});
