// A background command's label (docs/office-wire.md, part 4): its kind read
// on the machine through the same walk as the room, and a listening port only
// when the command's own words give one to a dev server or a database. The
// label is an enum and a number: nothing of the command comes out.
import { OfficeServiceKind as K } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { classifyService } from "../src/office/office-service-kind.ts";

describe("service kind", () => {
  it.each([
    // dev servers
    ["pnpm dev", K.DEV_SERVER],
    ["npm run start:web", K.DEV_SERVER],
    ["cd apps/web && pnpm --filter @app/web exec vite", K.DEV_SERVER],
    ["npx next dev", K.DEV_SERVER],
    ["uvicorn app.main:app --reload", K.DEV_SERVER],
    ["python -m http.server 8000", K.DEV_SERVER],
    ["node server.js", K.DEV_SERVER],
    ["docker compose up", K.DEV_SERVER],
    ["go run ./cmd/server", K.DEV_SERVER],
    ['bash -c "yarn dev"', K.DEV_SERVER],
    // tests and checks running on
    ["pnpm test --watch", K.TEST_WATCH],
    ["npx vitest", K.TEST_WATCH],
    ["go test ./...", K.TEST_WATCH],
    ["make test", K.TEST_WATCH],
    // builds
    ["pnpm build", K.BUILD],
    ["tsc -w -p .", K.BUILD],
    ["vite build --watch", K.BUILD],
    ["cargo build --release", K.BUILD],
    ["./scripts/build.sh", K.BUILD],
    // CI
    ["gh run watch 1234", K.CI_WATCH],
    ["gh pr checks 12 --watch", K.CI_WATCH],
    ["glab ci view", K.CI_WATCH],
    // git and hosting
    ["git fetch --all", K.GIT],
    ["gh pr view 12", K.GIT],
    ["sudo git pull", K.GIT],
    // databases
    ["redis-server", K.DATABASE],
    ["psql -h localhost mydb", K.DATABASE],
    ["pnpm db:migrate", K.DATABASE],
    ["npx prisma studio", K.DATABASE],
    // anything else
    ["tail -f server.log.txt | grep x", K.SCRIPT],
    ["sleep 600", K.SCRIPT],
    ["pnpm install", K.SCRIPT],
    ["", K.SCRIPT],
    ["$(cat cmd) dev", K.SCRIPT],
  ])("%s", (command, kind) => {
    expect(classifyService(command).kind).toBe(kind);
  });

  it.each([
    ["pnpm dev --port 5173", 5173],
    ["vite --port=4173", 4173],
    ["http-server -p 8080", 8080],
    ["PORT=3000 node server.js", 3000],
    ["VITE_PORT=5174 pnpm dev", 5174],
    ["cd web && PORT=3001 npm start", 3001],
    ['bash -c "pnpm dev --port 5175"', 5175],
    ["docker run -p 5432:5432 postgres", 5432],
    ["redis-server --port 6380", 6380],
    ["postgres -p 5433", 5433],
    ["npx next dev -p 3001", 3001],
    ["mysql -h db -P 3307 shop", 3307],
    // `-p` means the port only for programs where it does: MySQL's is its password (a number after it is a database name).
    ["mysql -u root -p 4321", 0],
    ["mysqld -p 4321", 0],
    ["pnpm dev -p 3000", 0],
    // Nothing given, or no port at all: unknown, never guessed.
    ["pnpm dev", 0],
    ["vite --port 99999", 0],
    ["vite --port $PORT", 0],
    ["PORT=abc pnpm dev", 0],
    // Not a listening port in another kind of command.
    ["ssh -p 2222 host tail -f log", 0],
    ["pnpm test --port 9999", 0],
  ])("%s → port %i", (command, port) => {
    expect(classifyService(command).port).toBe(port);
  });

  it("gives an enum and a number only, whatever the command holds", () => {
    const MARK = "ZZMARKER-0a7e-private";
    for (const command of [`TOKEN=${MARK} pnpm dev --port 5173`, `bash -c "cd ${MARK} && vite"`, `./${MARK}.sh`, `gh run watch --repo ${MARK}`]) {
      const label = classifyService(command);
      expect(Object.keys(label).sort()).toEqual(["kind", "port"]);
      expect(typeof label.kind).toBe("number");
      expect(typeof label.port).toBe("number");
      expect(JSON.stringify(label)).not.toContain(MARK);
    }
  });
});

describe("a chain of commands is read by its last command that says what it is", () => {
  it.each([
    // The commands of the experiment that came out as scripts: a guard in front, a kill before, a group.
    ["nc -z 127.0.0.1 5174 || PORT=5174 python3 -m http.server 5174 --bind 127.0.0.1", K.DEV_SERVER, 5174],
    ["(nc -z 127.0.0.1 5174 && echo busy) || PORT=5174 python3 -m http.server 5174", K.DEV_SERVER, 5174],
    ['pkill -f "http.server 5174"; sleep 1; cd /w && PORT=5175 python3 -m http.server 5175 --bind 127.0.0.1', K.DEV_SERVER, 5175],
    // Preparation in front.
    ["git pull && pnpm dev --port 5173", K.DEV_SERVER, 5173],
    ["pnpm install && pnpm dev", K.DEV_SERVER, 0],
    ["pnpm build && node dist/server.js", K.DEV_SERVER, 0],
    ["sleep 5 && git push", K.GIT, 0],
    // Something that only watches it behind.
    ["pnpm dev --port 3000 | tee dev.log", K.DEV_SERVER, 3000],
    ["pnpm dev & sleep 2; curl localhost:5173", K.DEV_SERVER, 0],
    // Groups.
    ["(cd web && vite --port 5173) &", K.DEV_SERVER, 5173],
    ["{ pnpm dev --port 3000; }", K.DEV_SERVER, 3000],
    // The port set in a command before the service still counts; one the guard checks does not.
    ["export PORT=3000; vite", K.DEV_SERVER, 3000],
    ["nc -z 127.0.0.1 5174 && vite", K.DEV_SERVER, 0],
    // No command says anything: a script, with no port.
    ["echo starting; sleep 600", K.SCRIPT, 0],
    ["nc -z 127.0.0.1 5174 || echo free", K.SCRIPT, 0],
    ["$(cat cmd) dev --port 5173", K.SCRIPT, 0],
  ])("%s", (command, kind, port) => {
    expect(classifyService(command)).toEqual({ kind, port });
  });
});
