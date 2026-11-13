// A device of the account talking to the machine's Connection over in-memory sockets,
// for tests that go through the end-to-end link: it sends sealed frames and
// waits for the answer with a given id.
import { type MessageInitShape, create } from "@bufbuild/protobuf";
import { type Frame, FrameSchema, type MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { type Session, generateKeyPair, startHandshake } from "@achoo254/chat-remote-protocol";
import type { ConfigStore } from "../../src/config.ts";
import type { AgentCore } from "../../src/core/agent-core.ts";
import { DeviceTrust } from "../../src/device-trust.ts";
import { Connection } from "../../src/link/connection.ts";
import type { AgentProvider } from "../../src/providers/types.ts";
import { trustDevice } from "./trusted-devices.ts";
import type { AuditLog } from "../../src/safety/audit-log.ts";
import type { LocalForward } from "../../src/tunnels/forward.ts";
import type { SecretService } from "../../src/sign-in-secrets/secret-service.ts";
import type { RemoteBrowser } from "../../src/remote-browser/remote-browser.ts";
import type { ScreenShare } from "../../src/screen-share/screen-share.ts";
import type { Workspaces } from "../../src/workspace/workspaces.ts";
import type { UsageApi } from "../../src/link/usage-link.ts";

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

export type DeviceLink = {
  /** Sends a request and resolves with the frame answering it. */
  request(id: string, body: Body): Promise<Frame>;
  /** Every frame the device received so far. */
  received: Frame[];
  /** The device's link closes. */
  close(): void;
};

export async function pairedDevice(ctx: {
  core: AgentCore;
  config: ConfigStore;
  audit: AuditLog;
  /** The machine's AIs; those with accounts answer the account requests. */
  providers?: readonly AgentProvider[];
  localForward?: LocalForward;
  secrets?: SecretService;
  browser?: RemoteBrowser;
  screenShare?: ScreenShare;
  workspaces?: Workspaces;
  usage?: UsageApi;
  machineInfo?: () => Promise<MachineInfo>;
}): Promise<DeviceLink> {
  const machineKey = await generateKeyPair(true);
  const device = await generateKeyPair();
  trustDevice(ctx.config, device.publicKey, "phone");
  const inbox: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  const conn = new Connection(
    {
      send: (d) => {
        inbox.push(d);
        wake?.();
      },
      close: () => wake?.(),
    },
    {
      core: ctx.core,
      config: ctx.config,
      audit: ctx.audit,
      ...(ctx.providers ? { providers: ctx.providers } : {}),
      ...(ctx.localForward ? { localForward: ctx.localForward } : {}),
      ...(ctx.secrets ? { secrets: ctx.secrets } : {}),
      ...(ctx.browser ? { browser: ctx.browser } : {}),
      ...(ctx.screenShare ? { screenShare: ctx.screenShare } : {}),
      ...(ctx.workspaces ? { workspaces: ctx.workspaces } : {}),
      ...(ctx.usage ? { usage: ctx.usage } : {}),
      machineKey: () => machineKey,
      trust: new DeviceTrust({ config: ctx.config }),
      machineInfo:
        ctx.machineInfo ??
        (async () => {
          throw new Error("unused");
        }),
      isSensitive: () => false,
      onPing: () => undefined,
    },
  );
  const next = async (): Promise<Uint8Array> => {
    for (;;) {
      const d = inbox.shift();
      if (d) return d;
      await new Promise<void>((r) => (wake = r));
    }
  };
  const hs = await startHandshake({ device, expectedMachineKey: machineKey.publicKey });
  conn.receive(hs.hello);
  const { session }: { session: Session } = await hs.finish(await next());
  const received: Frame[] = [];
  const waiting = new Map<string, (f: Frame) => void>();
  void (async () => {
    for (;;) {
      const f = session.open(await next());
      received.push(f);
      waiting.get(f.id)?.(f);
    }
  })();
  return {
    received,
    close: () => conn.close(),
    request: (id, body) =>
      new Promise((resolve) => {
        waiting.set(id, resolve);
        conn.receive(session.seal(create(FrameSchema, { id, body })));
      }),
  };
}
