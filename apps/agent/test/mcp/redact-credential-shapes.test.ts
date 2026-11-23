// redact() now also hides credentials by their well-known shape. This proves
// it only hides more: against a reference copy of redact() as it was before
// (secret values, `known` tokens, JWT, Bearer), ordinary text comes out the
// same, and text holding a new shape comes out the same except that exactly
// that shape became "[hidden]". Every fake credential below is assembled at
// run time from two halves, so no file holds a key-shaped string.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { forgetSecrets, hideNamedSecrets, redact, redactSecrets, redactTokens, rememberSecret } from "../../src/mcp/redact.ts";

afterEach(() => forgetSecrets());

/** redact() before credential shapes, as in the commit before (kept here as the reference). */
function referenceRedact(text: string, known: Iterable<string> = []): string {
	let out = redactSecrets(text);
	for (const token of known) if (token) out = out.split(token).join("[hidden]");
	return out.replace(/eyJ[\w-]{8,}(?:\.[\w-]*){0,2}/g, "[hidden]").replace(/\b(Bearer)\s+[^\s"'\\,;]+/gi, "$1 [hidden]");
}

const join = (a: string, b: string): string => a + b;
const FAKE = {
	anthropic: join("sk-ant-", "api03-EXAMPLEexample0123456789abcdefEXAMPLE"),
	openai: join("sk-proj-", "EXAMPLE0123456789exampleEXAMPLE"),
	githubClassic: join("ghp_", "EXAMPLEexample0123456789EXAMPLEexam"),
	githubOauth: join("gho_", "EXAMPLEexample0123456789EXAMPLEexam"),
	githubUser: join("ghu_", "EXAMPLEexample0123456789EXAMPLEexam"),
	githubServer: join("ghs_", "EXAMPLEexample0123456789EXAMPLEexam"),
	githubFine: join("github_pat_", "11EXAMPLE0123456789_exampleEXAMPLE0123"),
	awsKey: join("AKIA", "EXAMPLE0123456789".slice(0, 16)),
	awsSession: join("ASIA", "EXAMPLE9876543210".slice(0, 16)),
	slack: join("xoxb-", "123456789012-EXAMPLEexample"),
	google: join("AIza", "SyEXAMPLEexample0123456789EXAMPLEex"),
	gitlab: join("glpat-", "EXAMPLEexample0123456789"),
	typesafe: join("ts_", "live_EXAMPLE0123456789ab"),
};
const PEM = [join("-----BEGIN OPENSSH ", "PRIVATE KEY-----"), "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", join("-----END OPENSSH ", "PRIVATE KEY-----")].join("\n");
const URL_PASS = join("Sup3r", "S3cretExample");
const JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhIn0.c2ln";

/** Text the new shapes must leave alone. */
const ORDINARY = [
	"src/observatory/privacy/filter-hook-event.ts",
	"C:\\Users\\example-user\\work\\app\\.env.example",
	"commit 4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
	"4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
	"id 123e4567-e89b-12d3-a456-426614174000",
	"https://example.com/docs/page?lang=en&page=2",
	"git@github.com:example/app.git and ssh://git@example.com/app.git",
	"postgres://db.example:5432/app (no user info)",
	"pip install scikit-learn sk-learn-tutorial sk-short",
	"AKIA is a prefix; AKIA123 is too short",
	"max_tokens=4096 token_count=12 password: see the wiki",
	"-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----",
	"email user@example.invalid, path /home/example-user/.config/app",
	"ghp is GitHub's prefix; xoxb- alone; AIza short",
	`a JWT ${JWT} and Bearer opaque-123 stay hidden as before`,
	JSON.stringify({ url: "http://localhost:3000", email: "dev@example.com" }),
	JSON.stringify({ command: "curl http://localhost:3000", note: "mail a@b.example", list: ["ftp://x", "y@z"] }),
	"see (http://localhost:8080) or <https://example.com>, then mail a@b.example",
	"for parts_count in results_by_task: task-1 ts_x gh_x",
];

describe("redact() with credential shapes", () => {
	test("leaves ordinary text exactly as the reference does", () => {
		for (const text of ORDINARY) expect(redact(text), text).toBe(referenceRedact(text));
		rememberSecret("example-saved-secret-value");
		for (const text of [...ORDINARY, "uses example-saved-secret-value here"]) {
			expect(redact(text, ["known-token-1"]), text).toBe(referenceRedact(text, ["known-token-1"]));
		}
	});

	test("redactTokens() is the reference, unchanged", () => {
		rememberSecret("example-saved-secret-value");
		for (const text of [...ORDINARY, ...Object.values(FAKE), PEM, "example-saved-secret-value known-token-1"]) {
			expect(redactTokens(text, ["known-token-1"])).toBe(referenceRedact(text, ["known-token-1"]));
		}
	});

	test("hides each new shape, and only it: the rest is the reference's output", () => {
		for (const [name, fake] of Object.entries(FAKE)) {
			const text = `before ${JWT} key=${fake} after Bearer opaque-123 end`;
			expect(redact(text), name).toBe(referenceRedact(text).replace(fake, "[hidden]"));
		}
		const pemText = `key file:\n${PEM}\nnext line`;
		expect(redact(pemText)).toBe(referenceRedact(pemText).replace(PEM, "[hidden]"));
		const cutPem = `${PEM.split("\n").slice(0, 2).join("\n")}`;
		expect(redact(`out: ${cutPem}`)).toBe("out: [hidden]");
		const url = `DATABASE_URL=postgres://app:${URL_PASS}@db.example:5432/app`;
		expect(redact(url)).toBe(referenceRedact(url).replace(URL_PASS, "[hidden]"));
		expect(redact(url)).toContain(join("postgres", "://app:[hidden]@db.example"));
		const scheme = join("post", "gres");
		expect(redact(`${scheme}://user:pass@host/db`)).toBe(`${scheme}://user:[hidden]@host/db`);
	});

	test("hides a private key block without its END line only 4 KB past its header", () => {
		const header = join("-----BEGIN RSA ", "PRIVATE KEY-----");
		const tail = "after the key, ordinary text. ".repeat(100);
		const out = redact(`readme:\n${header}\n${"k".repeat(4_096)}${tail}`);
		expect(out.startsWith("readme:\n[hidden]")).toBe(true);
		expect(out).not.toContain("k".repeat(20));
		expect(out).toContain("after the key, ordinary text. ".repeat(99));
	});

	test("costs about as much as the reference on ordinary text of megabytes", () => {
		const source = readFileSync(new URL("../../src/machine.ts", import.meta.url), "utf8");
		const big = source.repeat(Math.ceil(8_000_000 / source.length));
		const median = (fn: () => unknown): number => {
			const runs: number[] = [];
			for (let i = 0; i < 7; i++) {
				const t = performance.now();
				fn();
				runs.push(performance.now() - t);
			}
			return runs.sort((a, b) => a - b)[3] ?? 0;
		};
		expect(redact(big)).toBe(referenceRedact(big));
		const reference = median(() => referenceRedact(big));
		const now = median(() => redact(big));
		console.log(`redact() on ${(big.length / 1e6).toFixed(1)} M chars: ${now.toFixed(2)} ms, reference ${reference.toFixed(2)} ms`);
		// The reference is a single cheap pass, so on a fast runner its time is a few milliseconds and the
		// ratio alone is noise: the floor keeps this a guard against a pass that grows with the text.
		expect(now).toBeLessThan(Math.max(4 * reference, 60));
	});

	test("takes linear time on long token-like runs", () => {
		const long = ["a".repeat(2_000_000), "sk-".repeat(300_000), "-".repeat(1_000_000), "=x".repeat(500_000)].join(" ");
		const t = performance.now();
		redact(long);
		hideNamedSecrets(long);
		expect(performance.now() - t).toBeLessThan(2_000);
	});
});

describe("hideNamedSecrets() (Observatory's content only)", () => {
	const pass = join("hunter", "2-example-value");
	test("hides values of names that say they are secret, in env, JSON (plain or escaped) and YAML", () => {
		expect(hideNamedSecrets(`DB_PASSWORD=${pass}\nAPI_KEY="${pass}"`)).toBe('DB_PASSWORD=[hidden]\nAPI_KEY="[hidden]"');
		expect(hideNamedSecrets(`{"client_secret": "${pass}", "name": "app"}`)).toBe('{"client_secret": "[hidden]", "name": "app"}');
		expect(hideNamedSecrets(`{\\"access_token\\":\\"${pass}\\"}`)).toBe('{\\"access_token\\":\\"[hidden]\\"}');
		expect(hideNamedSecrets(`data:\n  password: ${pass}\n  user: app`)).toBe("data:\n  password: [hidden]\n  user: app");
		expect(hideNamedSecrets(`curl "https://api.example/x?token=${pass}&page=2"`)).toBe('curl "https://api.example/x?token=[hidden]&page=2"');
	});

	test("leaves short numbers, references and other names alone", () => {
		for (const text of ["max_tokens=4096", "TOKEN=$GITHUB_TOKEN", "password=${DB_PASSWORD}", "API_KEY=<your key>", "name=app", '{"tokens": 12}', "PAGE=2"]) {
			expect(hideNamedSecrets(text), text).toBe(text);
		}
		for (const text of ORDINARY) expect(hideNamedSecrets(text), text).toBe(text);
	});
});
