// A second tunelo process wanting an access token: prints it as JSON, or the error.
import { IdentitySession } from "../../src/identity/session.ts";

const [dir = "", resource = ""] = process.argv.slice(2);
new IdentitySession(dir).getAccessToken(resource).then(
	(token) => process.stdout.write(JSON.stringify({ token })),
	(err: Error) => process.stdout.write(JSON.stringify({ error: err.message })),
);
