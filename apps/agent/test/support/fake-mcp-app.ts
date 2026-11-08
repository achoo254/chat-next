// A stand-in for the MCP server of an app (Chat or Localman): Streamable
// HTTP, stateless, Bearer tokens checked against a list the test controls.
import http from "node:http";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";

export type FakeMcpApp = {
  url: string;
  /** Tokens the server accepts; anything else gets 401. */
  accepted: Set<string>;
  /** Tokens accepted but lacking the tool's scope: 403 insufficient_scope. */
  lacking: Set<string>;
  /** Bearer tokens of every request, in order. */
  seen: string[];
  /** Tool calls the server ran: name and arguments. */
  calls: { name: string; args: unknown }[];
  /** Set: every request fails with this status and a body echoing its Authorization header (a careless proxy). */
  failWith?: number;
  close(): Promise<void>;
};

function buildServer(app: FakeMcpApp, bearer: string): McpServer {
  const server = new McpServer({ name: "fake-app", version: "0.0.0" });
  const run = (name: string, out: (args: Record<string, unknown>) => unknown) => async (args: Record<string, unknown>) => {
    app.calls.push({ name, args });
    return { content: [{ type: "text" as const, text: JSON.stringify(out(args)) }] };
  };
  server.registerTool("list_chats", { description: "The user's chats.", annotations: { readOnlyHint: true } }, run("list_chats", () => ({ chats: [{ id: 7, title: "Team" }] })));
  server.registerTool(
    "send_message",
    { description: "Send a text message.", inputSchema: z.object({ chat_id: z.number(), text: z.string() }) },
    // Echoes the bearer it got: a careless server must not leak it to the agent.
    run("send_message", (args) => ({ sent: args.text, debug: `authorization: Bearer ${bearer}` })),
  );
  server.registerTool(
    "get_chat",
    { description: "One chat.", inputSchema: z.object({ chat_id: z.number() }) },
    run("get_chat", () => ({ chat: { id: 7, title: "Team", member_count: 12 } })),
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
    calls: [],
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
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      app.seen.push(bearer);
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
