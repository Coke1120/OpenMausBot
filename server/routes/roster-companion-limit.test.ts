import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_JSON_BODY_BYTES } from "../../companion/src/proxy.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import {
  COMPANION_JSON_BODY_LIMIT,
  messagePages,
  pageSize,
  ROSTER_JSON_BUDGET,
} from "../host/message-pages.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, type Message } from "../store.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];
const BOTS = 25;
const PER_BOT = 10;
const PAD = 180_000;

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

function serve(store: Store): Promise<string> {
  const pages = messagePages(store);
  const deps = {
    store,
    pageSize,
    messagePage: pages.messagePage,
    messageWindow: pages.messageWindow,
    defaultPage: 50,
    viewerFor: () => ({}),
    visibleTo: () => ({
      bot: () => true,
      group: () => true,
      thread: () => true,
      sections: (sections: unknown) => sections,
      hides: () => false,
      everything: true,
      member: false,
    }),
    workspaceAccess: () => null,
    desktopMutationToken: () => undefined,
    companionMutationToken: () => undefined,
    cliOwnerToken: () => undefined,
    publicBotQueuedMessages: () => ({}),
    publicGroupState: (group: unknown) => group,
    wireBot: (bot: { id: string; name: string; threadId: string; tasks?: unknown }) => ({
      id: bot.id, name: bot.name, threadId: bot.threadId, tasks: bot.tasks ?? [],
    }),
    botComputerControlSnapshot: () => ({ held: false, helpReason: null }),
    groupUsageReader: { refresh() {} },
  } as unknown as ThreadRouteDeps;
  const routes = [createThreadRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { error: "not found" });
  });
  servers.push(server);
  return new Promise((ready) => server.listen(0, "127.0.0.1", () => {
    ready(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }));
}

async function document(url: string): Promise<{ status: number; bytes: number; body: any }> {
  const response = await fetch(url, { headers: { "accept-encoding": "identity" } });
  const text = await response.text();
  return { status: response.status, bytes: Buffer.byteLength(text), body: JSON.parse(text) };
}

function seed(store: Store, count: number, pad: number): Array<{ id: string; threadId: string }> {
  const filler = "x".repeat(pad);
  const bots = [];
  for (let index = 0; index < count; index++) {
    const bot = store.createBot({ name: `Bot ${index}` }, { seedMessages: false });
    const messages = Array.from({ length: PER_BOT }, (_, at) => ({
      id: `${bot.threadId}-${at}`,
      at: at + 1,
      role: "user",
      kind: "text",
      text: `${at === PER_BOT - 1 ? `BULK~${bot.id}~newest` : `BULK~${bot.id}~older~${at}`}~${filler}`,
      parentId: at === 0 ? null : `${bot.threadId}-${at - 1}`,
    })) as Message[];
    store.importTranscript(bot.threadId, messages, messages.at(-1)!.id);
    bots.push({ id: bot.id, threadId: bot.threadId });
  }
  return bots;
}

describe("roster responses the desktop companion can buffer", () => {
  it("keeps the numbered roster and the open thread under the 32 MiB proxy cap", async () => {
    expect(COMPANION_JSON_BODY_LIMIT).toBe(MAX_JSON_BODY_BYTES);
    expect(ROSTER_JSON_BUDGET).toBeLessThan(MAX_JSON_BODY_BYTES);
    expect(MAX_JSON_BODY_BYTES).toBe(32 * 1024 * 1024);

    const store = new Store(() => sonnet);
    const bots = seed(store, BOTS, PAD);
    const base = await serve(store);

    const empty = await document(`${base}/api/bots?messages=0`);
    expect(empty.status).toBe(200);
    expect(empty.bytes).toBeLessThan(1_000_000);
    expect(empty.bytes).toBeLessThan(COMPANION_JSON_BODY_LIMIT);
    expect(empty.body.bots).toHaveLength(BOTS);
    expect(empty.body.bots.every((bot: { messages: unknown[]; hasMore: boolean }) => bot.messages.length === 0 && bot.hasMore === true)).toBe(true);
    expect(JSON.stringify(empty.body)).not.toContain("BULK~");

    const open = bots[0]!;
    const thread = await document(`${base}/api/threads/${open.threadId}/messages?limit=200`);
    expect(thread.status).toBe(200);
    expect(thread.bytes).toBeLessThanOrEqual(ROSTER_JSON_BUDGET);
    expect(thread.bytes).toBeLessThan(COMPANION_JSON_BODY_LIMIT);
    expect(thread.body.messages.at(-1).text.startsWith(`BULK~${open.id}~newest~`)).toBe(true);

    const paged = await document(`${base}/api/bots?messages=200`);
    expect(paged.status).toBe(200);
    expect(paged.bytes).toBeLessThanOrEqual(ROSTER_JSON_BUDGET);
    expect(paged.bytes).toBeLessThan(COMPANION_JSON_BODY_LIMIT);
    expect(paged.body.bots).toHaveLength(BOTS);
    const counts = paged.body.bots.map((bot: { messages: unknown[] }) => bot.messages.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(Math.max(...counts)).toBeLessThan(PER_BOT);
    expect(Math.min(...counts)).toBeGreaterThan(0);
    for (const bot of paged.body.bots) {
      expect(bot.hasMore).toBe(true);
      expect(bot.messages.at(-1).text.startsWith(`BULK~${bot.id}~newest~`)).toBe(true);
    }

    const whole = await document(`${base}/api/bots`);
    expect(whole.status).toBe(200);
    expect(whole.bytes).toBeGreaterThan(COMPANION_JSON_BODY_LIMIT);
    expect(whole.body.bots.every((bot: { messages: unknown[] }) => bot.messages.length === PER_BOT)).toBe(true);

    for (const bot of bots) {
      const stored = store.messagesFor(bot.threadId);
      expect(stored).toHaveLength(PER_BOT);
      expect(stored.at(-1)?.text?.startsWith(`BULK~${bot.id}~newest~`)).toBe(true);
      expect(stored.at(-1)?.text?.length).toBeGreaterThan(PAD);
    }
  }, 120_000);

  it("pages an oversized thread forward and backward inside the same budget", async () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Wide" }, { seedMessages: false });
    const count = 6;
    const pad = "y".repeat(5_000_000);
    const messages = Array.from({ length: count }, (_, at) => ({
      id: `wide-${at}`,
      at: at + 1,
      role: "user",
      kind: "text",
      text: `${at}~${pad}`,
      parentId: at === 0 ? null : `wide-${at - 1}`,
    })) as Message[];
    store.importTranscript(bot.threadId, messages, messages.at(-1)!.id);
    const base = await serve(store);

    const first = await document(`${base}/api/threads/${bot.threadId}/messages?limit=200`);
    expect(first.status).toBe(200);
    expect(first.bytes).toBeLessThanOrEqual(ROSTER_JSON_BUDGET);
    expect(first.bytes).toBeLessThan(COMPANION_JSON_BODY_LIMIT);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.messages.at(-1).id).toBe(`wide-${count - 1}`);
    expect(first.body.messages.map((message: { id: string }) => message.id)).not.toContain("wide-0");
    const oldest = first.body.messages[0].id as string;

    const older = await document(`${base}/api/threads/${bot.threadId}/messages?limit=200&before=${encodeURIComponent(oldest)}`);
    expect(older.status).toBe(200);
    expect(older.bytes).toBeLessThanOrEqual(ROSTER_JSON_BUDGET);
    expect(older.body.messages.map((message: { id: string }) => message.id)).toContain("wide-0");
    expect(older.body.messages.map((message: { id: string }) => message.id)).not.toContain(oldest);

    const stored = store.messagesFor(bot.threadId);
    expect(stored).toHaveLength(count);
    expect(stored[0]?.text?.length).toBeGreaterThan(5_000_000);
  }, 120_000);
});
