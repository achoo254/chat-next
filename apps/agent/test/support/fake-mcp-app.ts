// A stand-in for the MCP server of an app (Chat or Localman): Streamable
// HTTP, stateless, Bearer tokens checked against a list the test controls.
import { createHash } from "node:crypto";
import http from "node:http";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";

export type FakeMcpApp = {
  url: string;
  /** Tokens the server accepts; anything else gets 401. */
  accepted: Set<string>;
  /** Tokens accepted but lacking the tool's scope: 403 insufficient_scope. */
  lacking: Set<string>;
  /** The path and query of every MCP request, in order. */
  urls: string[];
  /** Bearer tokens of every request, in order. */
  seen: string[];
  /** Tool calls the server ran: name and arguments. */
  calls: { name: string; args: unknown }[];
  /** Set: every request fails with this status and a body echoing its Authorization header (a careless proxy). */
  failWith?: number;
  /** Chat's media host: the part size it hands out, the files it stores (by media id), the PUTs it took. */
  media: { partSize: number; stored: Map<string, { name: string; bytes: Buffer }>; puts: number; uploads: Map<string, { name: string; hash: string; parts: Map<number, Buffer> }> };
  /**
   * Set: Chat's history as the chat inbox reads it. list_chats also lists its
   * chats as dialogs (newest seq; hidden ones left out, as the real server
   * does), and get_me and get_messages are served.
   */
  inbox?: FakeInbox;
  close(): Promise<void>;
};

/** A message of the fake's history, as get_messages answers it (protojson: int64 as strings). */
export type FakeMessage = { seq: number; from_id: number; text: string; date?: number; media?: { kind: string; file_name?: string }; action?: Record<string, unknown> };
export type FakeInbox = { selfId: number; chats: Map<number, FakeMessage[]>; hidden: Set<number>; users: { id: number; name: string }[] };

function inboxHistory(inbox: FakeInbox, args: Record<string, unknown>) {
  const all = inbox.chats.get(Number(args.chat_id)) ?? [];
  const offset = Number(args.offset_seq ?? 0);
  const limit = Number(args.limit ?? 0) || 50;
  const newer = args.direction === "newer";
  const picked = newer ? all.filter((m) => m.seq > offset).slice(0, limit) : all.filter((m) => offset === 0 || m.seq < offset).slice(-limit).reverse();
  const last = picked.at(-1)?.seq ?? offset;
  return {
    messages: picked.map((m) => ({ ...m, chat_id: String(args.chat_id), seq: String(m.seq), from_id: String(m.from_id), date: String(m.date ?? 1_764_000_000) })),
    users: inbox.users.map((u) => ({ id: String(u.id), name: u.name })),
    has_newer: newer && all.some((m) => m.seq > last),
  };
}

/** Chats the fake refuses as the real server does: one hidden from AI, one of an app that takes only what the user types. */
export const HIDDEN_CHAT = 9;
export const COMPOSER_ONLY_CHAT = 10;
const refusal = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "permission_denied", message } }) }] });
const HIDDEN = refusal("chat_hidden_from_ai: the user hid this chat from AI; it cannot be read or written with these tools");
const COMPOSER_ONLY = refusal(
  "imported_chat_composer_only: this chat only takes what you type or attach in Chat; forwards, copies, files of other messages and messages sent by tools or agents are not sent to the other app",
);

function buildServer(app: FakeMcpApp, bearer: string): McpServer {
  const server = new McpServer({ name: "fake-app", version: "0.0.0" });
  const run = (name: string, out: (args: Record<string, unknown>) => unknown) => async (args: Record<string, unknown>) => {
    app.calls.push({ name, args });
    return { content: [{ type: "text" as const, text: JSON.stringify(out(args)) }] };
  };
  server.registerTool(
    "list_chats",
    { description: "The user's chats.", annotations: { readOnlyHint: true }, inputSchema: z.object({ limit: z.number().optional(), cursor: z.string().optional() }) },
    run("list_chats", () => {
      const inbox = app.inbox;
      if (!inbox) return { chats: [{ id: 7, title: "Team" }] };
      const dialogs = [...inbox.chats].filter(([id]) => !inbox.hidden.has(id)).map(([id, messages]) => ({ chat_id: String(id), top_seq: String(messages.at(-1)?.seq ?? 0) }));
      return { dialogs };
    }),
  );
  const inbox = app.inbox;
  if (inbox) {
    server.registerTool("get_me", { description: "The signed-in user." }, run("get_me", () => ({ user: { id: String(inbox.selfId), name: "Me" } })));
    server.registerTool(
      "get_messages",
      { description: "Messages of a chat.", inputSchema: z.object({ chat_id: z.number(), offset_seq: z.number().optional(), direction: z.string().optional(), limit: z.number().optional() }) },
      async (args) => {
        if (inbox.hidden.has(args.chat_id)) {
          app.calls.push({ name: "get_messages", args });
          return HIDDEN;
        }
        return run("get_messages", (a) => inboxHistory(inbox, a))(args);
      },
    );
  }
  server.registerTool(
    "send_message",
    { description: "Send a text message.", inputSchema: z.object({ chat_id: z.number(), text: z.string() }) },
    // Echoes the bearer it got: a careless server must not leak it to the agent.
    run("send_message", (args) => ({ sent: args.text, debug: `authorization: Bearer ${bearer}` })),
  );
  server.registerTool("get_chat", { description: "One chat.", inputSchema: z.object({ chat_id: z.number() }) }, async (args) => {
    if (args.chat_id === HIDDEN_CHAT) {
      app.calls.push({ name: "get_chat", args });
      return HIDDEN;
    }
    // Chat 8 is one-to-one: no title, and the caller is listed before the other person.
    return run("get_chat", (a) =>
      a.chat_id === 8
        ? { chat: { id: 8, title: "", member_count: 2, peer_user_id: 22 }, users: [{ id: 11, name: "Me" }, { id: 22, name: "Lan" }] }
        : { chat: { id: a.chat_id, title: a.chat_id === COMPOSER_ONLY_CHAT ? "Zalo family" : "Team", member_count: 12 } },
    )(args);
  });
  // The upload of the real server (tools_media.go), int64 as protojson writes them: strings.
  server.registerTool(
    "start_media_upload",
    {
      description: "Start an upload.",
      inputSchema: z.object({ kind: z.string().optional(), file_name: z.string().optional(), mime_type: z.string().optional(), size: z.number().optional(), file_hash: z.string().optional(), upload_id: z.string().optional() }),
    },
    run("start_media_upload", (args) => {
      const hash = String(args.file_hash ?? "");
      for (const [id, file] of app.media.stored) {
        if (createHash("sha256").update(file.bytes).digest("hex") === hash) return { existing: { file_id: id } };
      }
      const uploadId = `u${app.media.uploads.size + 1}`;
      app.media.uploads.set(uploadId, { name: String(args.file_name ?? ""), hash, parts: new Map() });
      const count = Math.max(1, Math.ceil(Number(args.size ?? 0) / app.media.partSize));
      const base = app.url.replace(/\/mcp$/, "");
      return {
        upload: {
          upload_id: uploadId,
          part_size: String(app.media.partSize),
          parts: Array.from({ length: count }, (_, i) => ({ part_number: i + 1, url: `${base}/upload/${uploadId}/${i + 1}?sig=signed-${uploadId}` })),
          urls_expire_at: String(Math.floor(Date.now() / 1000) + 3600),
        },
      };
    }),
  );
  server.registerTool(
    "complete_media_upload",
    { description: "Finish an upload.", inputSchema: z.object({ upload_id: z.string(), parts: z.array(z.object({ part_number: z.number(), etag: z.string() })) }) },
    async (args) => {
      app.calls.push({ name: "complete_media_upload", args });
      const upload = app.media.uploads.get(args.upload_id);
      const ok = upload && args.parts.length === upload.parts.size && args.parts.every((p) => upload.parts.has(p.part_number) && p.etag === `"e-${args.upload_id}-${p.part_number}"`);
      if (!upload || !ok) return refusal("upload_incomplete");
      const bytes = Buffer.concat([...upload.parts].sort(([a], [b]) => a - b).map(([, b]) => b));
      if (createHash("sha256").update(bytes).digest("hex") !== upload.hash) return refusal("hash_mismatch");
      const id = `m${app.media.stored.size + 1}`;
      app.media.stored.set(id, { name: upload.name, bytes });
      return { content: [{ type: "text" as const, text: JSON.stringify({ media: { file_id: id, size: String(bytes.length) } }) }] };
    },
  );
  server.registerTool(
    "send_media",
    { description: "Send stored media.", inputSchema: z.object({ chat_id: z.number(), media_ids: z.array(z.string()), caption: z.string().optional(), reply_to_seq: z.number().optional() }) },
    async (args) => {
      app.calls.push({ name: "send_media", args });
      if (args.chat_id === HIDDEN_CHAT) return HIDDEN;
      if (args.chat_id === COMPOSER_ONLY_CHAT) return COMPOSER_ONLY;
      return { content: [{ type: "text" as const, text: JSON.stringify({ message: { seq: String(40 + app.calls.length) } }) }] };
    },
  );
  server.registerTool(
    "get_history_entry",
    { description: "A request sent earlier.", inputSchema: z.object({ id: z.string() }) },
    run("get_history_entry", () => ({
      request: { headers: [{ name: "Authorization", value: "Basic dXNlcjpwYXNz" }, { name: "Accept", value: "*/*" }] },
      response: { headers: { "set-cookie": "sid=secret", "content-type": "text/plain" } },
    })),
  );
  server.registerTool("list_collections", { description: "Collections.", annotations: { readOnlyHint: true } }, run("list_collections", () => ({ collections: [] })));
  server.registerTool(
    "send_request",
    { description: "Send an HTTP request.", inputSchema: z.object({ method: z.string(), url: z.string() }) },
    run("send_request", (args) => ({ status: 200, url: args.url })),
  );
  // Localman's workspaces (sharing.listWorkspaces): the personal one first.
  server.registerTool("list_workspaces", { description: "The caller's workspaces.", annotations: { readOnlyHint: true } }, run("list_workspaces", () => ({ items: [{ id: "ws-1", name: "Personal", role: "admin", personal: true }] })));
  // Localman's collections: col-1 is named; col-slow answers after the card stops waiting; others are unknown.
  server.registerTool("get_collection", { description: "One collection.", inputSchema: z.object({ collectionId: z.string() }) }, async (args) => {
    app.calls.push({ name: "get_collection", args });
    if (args.collectionId === "col-slow") await new Promise((r) => setTimeout(r, 4_000));
    if (args.collectionId !== "col-1" && args.collectionId !== "col-slow") return refusal("NOT_FOUND");
    return { content: [{ type: "text" as const, text: JSON.stringify({ id: args.collectionId, name: "Health checks" }) }] };
  });
  server.registerTool(
    "create_collection_node",
    {
      description: "Add a folder, request or example to a collection.",
      inputSchema: z.object({ collectionId: z.string(), kind: z.string(), parentId: z.string().nullable(), name: z.string(), draft: z.record(z.string(), z.unknown()).optional() }),
    },
    run("create_collection_node", (args) => ({ id: "node-1", kind: args.kind, name: args.name })),
  );
  // The Knowledge Base (kb-next apps/server/src/mcp): reads, and save_note in two calls.
  const doc = { id: "d1", title: "Deploy notes", url: "https://kb.example/d/d1", visibility: "private" };
  server.registerTool("search", { description: "Search the Knowledge Base.", inputSchema: z.object({ query: z.string(), space: z.string().optional(), limit: z.number().optional() }) }, run("search", (args) => ({ query: args.query, results: [doc] })));
  server.registerTool("get_document", { description: "One document.", inputSchema: z.object({ id: z.string() }) }, run("get_document", () => ({ ...doc, markdown: "# Deploy" })));
  server.registerTool("list_spaces", { description: "Spaces." }, run("list_spaces", () => ({ spaces: [{ slug: "ops", url: "https://kb.example/s/ops" }] })));
  server.registerTool("recent", { description: "Recent documents.", inputSchema: z.object({ limit: z.number().optional() }) }, run("recent", () => ({ documents: [doc] })));
  server.registerTool(
    "save_note",
    {
      description: "Save a private note, in two calls.",
      inputSchema: z.object({ title: z.string(), markdown: z.string(), space: z.string().optional(), lang: z.string().optional(), confirm_token: z.string().optional() }),
    },
    run("save_note", (args) =>
      args.confirm_token
        ? { saved: true, document: { ...doc, id: "d2", title: args.title, url: "https://kb.example/d/d2" } }
        : { preview: { title: args.title, visibility: "private" }, confirm_token: "ct-1", next: "call again with confirm_token" },
    ),
  );
  server.registerTool("delete_messages", { description: "Not offered by tunelo.", inputSchema: z.object({ chat_id: z.number() }) }, run("delete_messages", () => ({ deleted: true })));
  return server;
}

export async function startFakeMcpApp(): Promise<FakeMcpApp> {
  const httpServer = http.createServer();
  const app: FakeMcpApp = {
    url: "",
    accepted: new Set(),
    lacking: new Set(),
    seen: [],
    urls: [],
    calls: [],
    media: { partSize: 5, stored: new Map(), puts: 0, uploads: new Map() },
    close: () =>
      new Promise((r) => {
        httpServer.close(() => r());
        httpServer.closeAllConnections();
      }),
  };
  httpServer.on("request", (req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      // A part PUT to the media host: the signature in the URL, no Authorization header.
      const part = /^\/upload\/(\w+)\/(\d+)\?sig=signed-(\w+)$/.exec(req.url ?? "");
      if (req.method === "PUT" && part) {
        const [, uploadId = "", n = "0", signed] = part;
        const upload = app.media.uploads.get(uploadId);
        if (!upload || signed !== uploadId || req.headers.authorization) {
          res.writeHead(403).end();
          return;
        }
        app.media.puts++;
        upload.parts.set(Number(n), Buffer.concat(chunks));
        res.writeHead(200, { etag: `"e-${uploadId}-${n}"` }).end();
        return;
      }
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      app.seen.push(bearer);
      app.urls.push(req.url ?? "");
      if (app.failWith) {
        res.writeHead(app.failWith, { "content-type": "text/plain" }).end(`upstream failed for Authorization: ${String(req.headers.authorization)} (token ${bearer})`);
        return;
      }
      if (!app.accepted.has(bearer)) {
        res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' }).end();
        return;
      }
      if (app.lacking.has(bearer)) {
        res.writeHead(403, { "www-authenticate": 'Bearer error="insufficient_scope", scope="chat:write"' }).end();
        return;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method ?? "POST",
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const server = buildServer(app, bearer);
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      await server.close();
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const address = httpServer.address();
  app.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
  return app;
}
