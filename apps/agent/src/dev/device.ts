// Development stand-in for a device of the account (side A) in the terminal.
//   node src/dev/device.ts key                       (prints the device's public key)
//   node src/dev/device.ts machine <machine key>     (the machine key Chat lists, base64url)
//   node src/dev/device.ts chat <ws-url> <folder> "<first message>" [--yes] [--model haiku]
// The machine accepts the device only once Chat lists its key for the
// account (RegisterDevice; the web does it). The device key and the machine
// key live in $CHAT_DEV_DEVICE (default: ./dev-device.json). Approvals are
// asked on stdin unless --yes.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { create } from "@bufbuild/protobuf";
import { Decision, FrameSchema, type Frame, PromptState, Role } from "@achoo254/chat-proto/remote/remote";
import { type Session, exportPrivateKey, fromBase64Url, generateKeyPair, importKeyPair, startHandshake, toBase64Url } from "@achoo254/chat-remote-protocol";
import WebSocket from "ws";

const FILE = process.env.CHAT_DEV_DEVICE ?? "dev-device.json";
type Saved = { key: string; machineKey?: string };

async function device() {
  if (existsSync(FILE)) {
    const s = JSON.parse(readFileSync(FILE, "utf8")) as Saved;
    return { saved: s, pair: await importKeyPair(fromBase64Url(s.key)) };
  }
  const k = await generateKeyPair(true);
  const saved: Saved = { key: toBase64Url(await exportPrivateKey(k.privateKey)) };
  writeFileSync(FILE, JSON.stringify(saved), { mode: 0o600 });
  return { saved, pair: await importKeyPair(fromBase64Url(saved.key)) };
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "nodebuffer";
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function next(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    ws.once("message", (d: Buffer) => resolve(new Uint8Array(d)));
    ws.once("close", (code, reason) => reject(new Error(`closed ${code} ${reason.toString()}`)));
  });
}

async function printKey() {
  const { pair: key } = await device();
  console.log(toBase64Url(key.publicKey));
}

async function setMachineKey(machineKey: string) {
  if (fromBase64Url(machineKey).length !== 32) throw new Error("a machine key is 32 bytes, base64url");
  const { saved } = await device();
  saved.machineKey = machineKey;
  writeFileSync(FILE, JSON.stringify(saved), { mode: 0o600 });
  console.log(`machine key ${machineKey.slice(0, 12)}… saved`);
}

async function chat(url: string, dir: string, text: string, yes: boolean, model: string) {
  const { saved, pair: key } = await device();
  if (!saved.machineKey) throw new Error("save the machine key first (device.ts machine <key>)");
  const ws = await open(url);
  const hs = await startHandshake({ device: key, expectedMachineKey: fromBase64Url(saved.machineKey) });
  ws.send(hs.hello);
  const { session } = await hs.finish(await next(ws));
  const send = (s: Session, f: Parameters<typeof create<typeof FrameSchema>>[1]) => ws.send(s.seal(create(FrameSchema, f)));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const printed = new Map<string, number>();
  let threadId = "";
  const answered = new Set<string>();

  const onFrame = async (f: Frame) => {
    const b = f.body;
    if (b.case === "error") return console.log(`\n[error ${b.value.code}] ${b.value.message}`);
    if (b.case === "threadCreated") {
      threadId = b.value.thread?.id ?? "";
      return console.log(`[thread ${threadId.slice(0, 8)} in ${b.value.thread?.dir}]`);
    }
    if (b.case !== "threadItems") return;
    for (const item of b.value.items) {
      const v = item.body;
      if (v.case === "text" && v.value.role !== Role.USER) {
        const seen = printed.get(item.id) ?? 0;
        if (v.value.role === Role.ASSISTANT) process.stdout.write(v.value.text.slice(seen));
        printed.set(item.id, v.value.text.length);
        if (!v.value.partial && v.value.role === Role.ASSISTANT) process.stdout.write("\n");
      } else if (v.case === "toolCall") {
        console.log(`\n  ▸ ${v.value.name} ${v.value.summary}`);
      } else if (v.case === "diff") {
        console.log(`  ± ${v.value.path} +${v.value.added} -${v.value.removed}`);
      } else if (v.case === "approval" && v.value.state === PromptState.PENDING && !answered.has(item.id)) {
        answered.add(item.id);
        const tag = v.value.sensitive ? " [SENSITIVE]" : "";
        const ans = yes ? "y" : (await rl.question(`\n  ? allow ${v.value.name} ${v.value.summary}${tag} [y/s(ession)/N] `)).trim();
        const decision = ans === "y" ? Decision.ALLOW : ans === "s" ? Decision.ALLOW_SESSION : Decision.DENY;
        send(session, { id: "r", body: { case: "threadRespond", value: { threadId, itemId: item.id, expectedRevision: item.revision, answer: { case: "decision", value: decision } } } });
      } else if (v.case === "question" && v.value.state === PromptState.PENDING && !answered.has(item.id)) {
        answered.add(item.id);
        const answers = [];
        for (const q of v.value.questions) {
          const opts = q.options.map((o, i) => `${i + 1}) ${o.label}`).join("  ");
          const a = yes ? "1" : await rl.question(`\n  ? ${q.question}  ${opts} > `);
          answers.push({ values: [q.options[Number(a) - 1]?.label ?? a] });
        }
        send(session, { id: "r", body: { case: "threadRespond", value: { threadId, itemId: item.id, expectedRevision: item.revision, answer: { case: "answers", value: { answers } } } } });
      } else if (v.case === "turn" && v.value.state > 1 && !answered.has(item.id)) {
        answered.add(item.id);
        const ctx = v.value.contextWindow ? ` · context ${v.value.contextTokens}/${v.value.contextWindow}` : "";
        console.log(`[turn ${["", "", "done", "interrupted", "failed"][v.value.state]} in ${v.value.durationMs} ms${ctx}]`);
        const more = (await rl.question("you (empty to quit) > ").catch(() => "")).trim();
        if (!more) {
          ws.close();
          rl.close();
          return;
        }
        send(session, { id: "s", body: { case: "threadSend", value: { threadId, text: more, clientMsgId: crypto.randomUUID() } } });
      } else if (v.case === "error") {
        console.log(`[agent error] ${v.value.message}`);
      }
    }
  };

  let chain = Promise.resolve();
  ws.on("message", (d: Buffer) => {
    const f = session.open(new Uint8Array(d));
    chain = chain.then(() => onFrame(f));
  });
  ws.on("close", (c) => {
    console.log(`[connection closed ${c}]`);
    process.exit(0);
  });
  send(session, { id: "c", body: { case: "threadCreate", value: { provider: "claude", model, dir, text, consent: { sensitive: false, projectSettings: false } } } });
}

/** Round trips of sealed ping frames, to measure latency through the relay. */
async function ping(url: string, count: number) {
  const { saved, pair: key } = await device();
  if (!saved.machineKey) throw new Error("save the machine key first (device.ts machine <key>)");
  const t0 = performance.now();
  const ws = await open(url);
  const hs = await startHandshake({ device: key, expectedMachineKey: fromBase64Url(saved.machineKey) });
  ws.send(hs.hello);
  const { session } = await hs.finish(await next(ws));
  console.log(`connect + handshake: ${Math.round(performance.now() - t0)} ms`);
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    ws.send(session.seal(create(FrameSchema, { id: String(i), body: { case: "ping", value: {} } })));
    for (;;) {
      const f = session.open(await next(ws));
      if (f.id === String(i)) break;
    }
    times.push(performance.now() - start);
  }
  times.sort((x, y) => x - y);
  const q = (p: number) => Math.round(times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? 0);
  console.log(`ping x${count}: p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, max ${q(1)} ms`);
  ws.close();
  process.exit(0);
}

const [cmd, url, a, b, ...rest] = process.argv.slice(2);
const model = rest.includes("--model") ? (rest[rest.indexOf("--model") + 1] ?? "") : "";
if (cmd === "ping" && url) await ping(url, Number(a ?? 50));
else if (cmd === "key") await printKey();
else if (cmd === "machine" && url) await setMachineKey(url);
else if (cmd === "chat" && url && a && b) await chat(url, a, b, rest.includes("--yes"), model);
else console.log("usage: device.ts key | machine <machine key> | ping <ws-url> [count] | chat <ws-url> <folder> <text> [--yes] [--model m]");
