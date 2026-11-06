// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { optimisticMessageId } from "./optimistic-send";
import { initialState, reducer, StoreProvider, useStore, type Action, type AppState, type Bot, type Message } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

const line = (id: string, at: number, extra: Partial<Message> = {}): Message => ({
  id, at, role: "user", kind: "text", text: id, parentId: null, ...extra,
});
const rosterBot = (index: number, extra: Partial<Bot> = {}): Bot => ({
  id: `bot-${index}`,
  threadId: `thread-${index}`,
  name: `Bot ${index}`,
  title: "",
  description: "",
  notifications: false,
  unread: false,
  color: "green",
  modelSelection: { instanceId: "fake", model: "fixture" },
  tasks: [
    { threadId: `thread-${index}`, title: "main", createdAt: 1 },
    { threadId: `task-${index}`, title: "side", createdAt: 2 },
  ],
  messages: [],
  hasMore: true,
  ...extra,
});
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const pathOf = (input: RequestInfo | URL) => typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
const page = (threadId: string, text: string) => ({
  messages: [line(`${threadId}-recent`, 5, { text })],
  hasMore: true,
  activeLeafId: `${threadId}-recent`,
});

let state!: AppState;
let dispatch!: Dispatch<Action>;
let root: Root;
let container: HTMLDivElement;
function Probe() {
  ({ state, dispatch } = useStore());
  return null;
}

async function mount(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  FixtureEventSource.opened = [];
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, String(value)); },
    removeItem: (key: string) => { stored.delete(key); },
    clear: () => stored.clear(),
  });
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", fetch);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  FixtureEventSource.opened[0]!.send({ kind: "hello", resumed: false, cursor: "fixture:0" });
}

afterEach(() => {
  flushSync(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe("opening the roster", () => {
  it("asks for no messages, then the selected thread, and still pages and switches", async () => {
    const calls: string[] = [];
    const bots = Array.from({ length: 25 }, (_, index) => rosterBot(index));
    await mount(async (input, init) => {
      const path = pathOf(input);
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/bots?messages=0") return json({ bots, groups: [], sections: [] });
      if (path === "/api/threads/thread-0/messages?limit=200") return json(page("thread-0", "recent-0"));
      if (path === "/api/threads/thread-1/messages?limit=200") return json(page("thread-1", "recent-1"));
      if (path.startsWith("/api/threads/thread-0/messages?limit=200&before=")) {
        return json({ messages: [line("older", 1, { text: "older" })], hasMore: false });
      }
      if (path === "/api/bots/bot-0/tasks/task-0?messages=200" && init?.method === "POST") {
        return json({ bot: { ...rosterBot(0), threadId: "task-0", messages: [line("task-msg", 9, { text: "task" })], hasMore: false } });
      }
      return json({});
    });

    await vi.waitFor(() => expect(state.bots[0]?.messages[0]?.text).toBe("recent-0"));
    expect(state.bots).toHaveLength(25);
    expect(state.selectedId).toBe("bot-0");
    expect(state.bots[0]?.activeLeafId).toBe("thread-0-recent");
    expect(calls.filter((call) => call.startsWith("GET /api/bots"))).toEqual(["GET /api/bots?messages=0"]);
    expect(calls.some((call) => call.includes("/api/bots?messages=200"))).toBe(false);
    expect(calls.filter((call) => call === "GET /api/threads/thread-0/messages?limit=200")).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify({ bots, groups: [] }))).toBeLessThan(32 * 1024 * 1024);

    flushSync(() => dispatch({ type: "select", id: "bot-1" }));
    await vi.waitFor(() => expect(state.bots.find((bot) => bot.id === "bot-1")?.messages[0]?.text).toBe("recent-1"));

    flushSync(() => dispatch({ type: "select", id: "bot-0" }));
    flushSync(() => dispatch({ type: "loadOlderMessages", threadId: "thread-0" }));
    await vi.waitFor(() => expect(state.bots[0]?.messages[0]?.id).toBe("older"));
    expect(calls.some((call) => call.startsWith("GET /api/threads/thread-0/messages?limit=200&before=thread-0-recent"))).toBe(true);
    expect(state.bots[0]?.messages.map((message) => message.id)).toEqual(["older", "thread-0-recent"]);

    flushSync(() => dispatch({ type: "switchTask", botId: "bot-0", threadId: "task-0" }));
    await vi.waitFor(() => expect(state.bots[0]?.messages[0]?.text).toBe("task"));
    expect(calls).toContain("POST /api/bots/bot-0/tasks/task-0?messages=200");
    expect(calls.some((call) => call.includes("/api/bots?messages=200"))).toBe(false);
  });

  it("does not fetch a thread the roster already filled", async () => {
    const calls: string[] = [];
    const filled = rosterBot(0, { messages: [line("held", 1)], hasMore: true });
    await mount(async (input) => {
      const path = pathOf(input);
      calls.push(path);
      if (path === "/api/bots?messages=0") return json({ bots: [filled], groups: [], sections: [] });
      return json({});
    });
    await vi.waitFor(() => expect(state.hydrated).toBe(true));
    expect(state.bots[0]?.messages[0]?.id).toBe("held");
    expect(calls.some((path) => path.startsWith("/api/threads/"))).toBe(false);
  });

  it("keeps a live message that lands while the open thread is loading", async () => {
    let threads = 0;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { release = done; });
    const bot = rosterBot(0);
    await mount(async (input) => {
      const path = pathOf(input);
      if (path === "/api/bots?messages=0") return json({ bots: [bot], groups: [], sections: [] });
      if (path === "/api/threads/thread-0/messages?limit=200") {
        threads += 1;
        if (threads === 1) throw new Error("prefetch failed");
        return pending;
      }
      return json({});
    });
    await vi.waitFor(() => expect(state.hydrated).toBe(true));
    await vi.waitFor(() => expect(threads).toBe(2));
    FixtureEventSource.opened[0]!.send({
      kind: "message",
      threadId: "thread-0",
      message: line("live-1", 20, { text: "live" }),
    });
    await vi.waitFor(() => expect(state.bots[0]?.messages.map((message) => message.id)).toEqual(["live-1"]));
    release(new Response(JSON.stringify({
      messages: [line("page-1", 10, { text: "page" })],
      hasMore: true,
      activeLeafId: "page-1",
    })));
    await vi.waitFor(() => expect(state.bots[0]?.messages.map((message) => message.id)).toEqual(["page-1", "live-1"]));
    expect(state.bots[0]?.hasMore).toBe(true);
  });
});

describe("threadTail", () => {
  const bot = (messages: Message[], generation = 0): AppState => ({
    ...initialState,
    hydrated: true,
    bots: [rosterBot(0, { messages })],
    transcriptGeneration: generation ? { "thread-0": generation } : {},
  });

  it("replaces an optimistic send with the page's copy and keeps a newer live row", () => {
    const optimistic = line(optimisticMessageId("s1"), 1, { text: "hi", sendId: "s1" });
    const live = line("live", 9, { text: "live" });
    const page = line("real", 2, { text: "hi", sendId: "s1" });
    const next = reducer(bot([optimistic, live]), {
      type: "threadTail", threadId: "thread-0", generation: 0, messages: [page], hasMore: true, activeLeafId: "real",
    });
    expect(next.bots[0]?.messages.map((message) => message.id)).toEqual(["real", "live"]);
  });

  it("leaves a transcript that already reaches older than the page", () => {
    const older = line("old", 1);
    const held = line("mid", 5);
    const next = reducer(bot([older, held]), {
      type: "threadTail", threadId: "thread-0", generation: 0, messages: [held, line("new", 9)], hasMore: false, activeLeafId: "new",
    });
    expect(next.bots[0]?.messages.map((message) => message.id)).toEqual(["old", "mid"]);
  });

  it("ignores a page from an older transcript generation", () => {
    const current = bot([line("kept", 1)], 2);
    const next = reducer(current, {
      type: "threadTail", threadId: "thread-0", generation: 1, messages: [line("stale", 2)], hasMore: false, activeLeafId: "stale",
    });
    expect(next).toBe(current);
  });
});
