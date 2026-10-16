// Multi-user end-to-end runner: starts the local backend (server/cmd/e2e-stack:
// throwaway PostgreSQL, fake IdP with the test accounts An, Bình, Chi (operator), Dũng, Giang, Hạnh and Khoa,
// the real api) and the Vite dev server, runs the *.e2e.ts files with
// node:test, then stops everything it started.
//
//   pnpm e2e                 run every scenario
//   pnpm e2e private-chat    run the files whose name contains the filter
//   pnpm e2e --serve         start the stack and keep it running, to chat
//                            with yourself in several browser profiles
//
// The ports are fixed (Vite 5173 proxies to the api on 4600), so a port in
// use stops the run with its owner instead of starting a second stack.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_DIR = fileURLToPath(new URL("../../../../server/", import.meta.url));
const E2E_DIR = fileURLToPath(new URL("./", import.meta.url));
const WEB_ORIGIN = "http://localhost:5173";
const PORTS = [4600, 4610, 4630, 5173];
const READY_TIMEOUT_MS = 180_000;

const children: ChildProcess[] = [];

function portOwner(port: number): string {
	try {
		return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

function start(command: string, args: string[], cwd: string, onLine: (line: string) => void): ChildProcess {
	const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: false });
	children.push(child);
	for (const stream of [child.stdout, child.stderr]) {
		let buffered = "";
		stream?.on("data", (chunk: Buffer) => {
			buffered += chunk.toString();
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			lines.forEach(onLine);
		});
	}
	return child;
}

function waitFor(what: string, check: (resolve: () => void) => void, child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what}: not ready after ${READY_TIMEOUT_MS / 1000}s`)), READY_TIMEOUT_MS);
		child.once("exit", (code) => reject(new Error(`${what} exited early with code ${code}`)));
		check(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function stopAll(): Promise<void> {
	await Promise.all(
		children.map(
			(child) =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) return resolve();
					const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
					child.once("exit", () => {
						clearTimeout(kill);
						resolve();
					});
					child.kill("SIGTERM");
				}),
		),
	);
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const serve = args.includes("--serve");
	const filter = args.find((a) => !a.startsWith("--")) ?? "";

	const busy = PORTS.map(portOwner).filter(Boolean);
	if (busy.length > 0) {
		console.error("e2e: these ports are in use; stop the owner (or the earlier run) first:\n" + busy.join("\n"));
		return 1;
	}

	// A built binary receives SIGTERM directly; `go run` would leave it orphaned.
	const binDir = mkdtempSync(join(tmpdir(), "chat-e2e-bin-"));
	try {
		const bin = join(binDir, "e2e-stack");
		console.log("e2e: building server/cmd/e2e-stack");
		execFileSync("go", ["build", "-o", bin, "./cmd/e2e-stack"], { cwd: SERVER_DIR, stdio: "inherit" });

		let stackReady: () => void = () => {};
		const stack = start(bin, [], SERVER_DIR, (line) => {
			if (line.startsWith("e2e-stack ready")) stackReady();
			else if (line.trim() !== "") console.log("[stack]", line);
		});
		await waitFor("backend", (resolve) => (stackReady = resolve), stack);

		let webReady: () => void = () => {};
		const web = start("pnpm", ["exec", "vite", "--logLevel", "warn"], APP_DIR, (line) => {
			if (line.trim() !== "") console.log("[vite]", line);
		});
		const poll = setInterval(() => {
			fetch(WEB_ORIGIN + "/")
				.then((r) => r.ok && webReady())
				.catch(() => {});
		}, 250);
		await waitFor("vite", (resolve) => (webReady = resolve), web).finally(() => clearInterval(poll));

		if (serve) {
			console.log(
				`e2e: stack running. Open ${WEB_ORIGIN} in several browser profiles and pick An, Bình, Chi, Dũng, Giang or Hạnh on the sign-in page (Chi is an operator). Ctrl+C stops it.`,
			);
			await new Promise<void>((resolve) => {
				process.once("SIGINT", resolve);
				process.once("SIGTERM", resolve);
			});
			return 0;
		}

		const files = readdirSync(E2E_DIR)
			.filter((f) => f.endsWith(".e2e.ts") && f.includes(filter))
			.map((f) => join(E2E_DIR, f));
		if (files.length === 0) {
			console.error(`e2e: no *.e2e.ts file matches "${filter}"`);
			return 1;
		}
		// One file at a time: every scenario shares the one stack and the 16 GB machine.
		const test = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
			cwd: APP_DIR,
			stdio: "inherit",
			env: { ...process.env, E2E_WEB_ORIGIN: WEB_ORIGIN },
		});
		children.push(test);
		return await new Promise<number>((resolve) => test.once("exit", (code) => resolve(code ?? 1)));
	} finally {
		await stopAll();
		rmSync(binDir, { recursive: true, force: true });
	}
}

process.exitCode = await main().catch((err: unknown) => {
	console.error("e2e:", err instanceof Error ? err.message : err);
	return 1;
});
