// The one sign-in of tunelo-agent asks for the three resources, and every
// request to the token endpoint names one: without it the IdP answers
// invalid_target and burns the approved device code.
import { discover } from "@tunelo/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { pollAgentTokens, startAgentAuthorization } from "../../src/identity/agent-login.ts";
import { AGENT_CLIENT_ID, AGENT_SCOPE, appResources } from "../../src/identity/session.ts";
import { type FakeIdp, fakeJwt, startFakeIdp } from "../support/fake-idp.ts";

let idp: FakeIdp;
beforeEach(async () => {
  idp = await startFakeIdp();
});
afterEach(() => idp.close());

const noWait = { sleep: async () => undefined };

describe("tunelo-agent device sign-in", () => {
  test("asks for the three apps at once and names the resource on every poll", async () => {
    idp.tokenReplies.push(
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 200, body: { access_token: fakeJwt("acc_1"), refresh_token: "rt", id_token: fakeJwt("acc_1"), expires_in: 900 } },
    );
    const endpoints = await discover(idp.issuer);
    const authorization = await startAgentAuthorization(endpoints, idp.issuer, "Mac mini");
    const tokens = await pollAgentTokens(endpoints, idp.issuer, authorization, "tunnel", noWait);
    expect(tokens.refreshToken).toBe("rt");

    const resources = appResources(idp.issuer);
    const start = idp.requests.find((r) => r.path === "/device/auth");
    expect(start?.form.get("client_id")).toBe(AGENT_CLIENT_ID);
    expect(start?.form.get("scope")).toBe(AGENT_SCOPE);
    expect(start?.form.getAll("resource")).toEqual([resources.tunnel, resources.chat, resources.localman]);

    const polls = idp.requests.filter((r) => r.path === "/token");
    expect(polls).toHaveLength(3);
    for (const poll of polls) {
      expect(poll.form.get("client_id")).toBe(AGENT_CLIENT_ID);
      expect(poll.form.getAll("resource")).toEqual([resources.tunnel]);
      expect(poll.form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    }
  });

  test("polls every 5 s when the IdP names no interval", async () => {
    idp.tokenReplies.push({ status: 200, body: { access_token: fakeJwt("acc_1"), refresh_token: "rt", expires_in: 900 } });
    const endpoints = await discover(idp.issuer);
    const authorization = { ...(await startAgentAuthorization(endpoints, idp.issuer, "Mac mini")), interval: 0 };
    const waits: number[] = [];
    await pollAgentTokens(endpoints, idp.issuer, authorization, "tunnel", { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([5000]);
  });

  test("a denied sign-in ends with the IdP's reason", async () => {
    idp.tokenReplies.push({ status: 400, body: { error: "access_denied" } });
    const endpoints = await discover(idp.issuer);
    const authorization = await startAgentAuthorization(endpoints, idp.issuer, "Mac mini");
    await expect(pollAgentTokens(endpoints, idp.issuer, authorization, "chat", noWait)).rejects.toThrow(/denied/);
    expect(idp.requests.filter((r) => r.path === "/token").at(-1)?.form.get("resource")).toBe(appResources(idp.issuer).chat);
  });
});
