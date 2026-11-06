import { describe, expect, it } from "vitest";

import type { Message } from "../store.ts";
import { fitMessages, fitRosterPayload, jsonUtf8Size, pageMessage, TOOL_OUTPUT_PREVIEW } from "./message-pages.ts";

const step = (output: string | undefined, extra: Partial<Message> = {}): Message => ({
  id: "m1", role: "bot", kind: "activity", at: 1, text: "", turnId: "t1",
  tool: { name: "Read", ok: true, summary: "read notes.md", input: JSON.stringify({ path: "notes.md", text: "x".repeat(5_000) }), output },
  ...extra,
} as Message);

describe("pageMessage", () => {
  it("leaves a step whose output fits the preview exactly as stored", () => {
    for (const output of [undefined, "", "short", "y".repeat(TOOL_OUTPUT_PREVIEW)]) {
      const message = step(output);
      expect(pageMessage(message)).toBe(message);
    }
  });

  it("cuts a long output to its start, marks it clipped and keeps everything else", () => {
    const message = step("z".repeat(6_000));
    const paged = pageMessage(message) as Message;
    expect(paged.tool).toEqual({ ...message.tool, output: "z".repeat(TOOL_OUTPUT_PREVIEW), clipped: true });
    expect(paged.tool!.input).toBe(message.tool!.input);
    expect({ ...paged, tool: undefined }).toEqual({ ...message, tool: undefined });
    expect(message.tool!.output).toHaveLength(6_000);
    expect(message.tool).not.toHaveProperty("clipped");
  });

  it("never splits a surrogate pair at the cut", () => {
    const output = `${"a".repeat(TOOL_OUTPUT_PREVIEW - 1)}😀${"b".repeat(50)}`;
    const paged = pageMessage(step(output)) as Message;
    expect(paged.tool!.output).toBe("a".repeat(TOOL_OUTPUT_PREVIEW - 1));
    expect(paged.tool).toHaveProperty("clipped", true);
  });

  it("keeps whole the rows whose output is the reply itself", () => {
    const long = "r".repeat(6_000);
    const rows: Array<Partial<Message>> = [
      { relay: { kind: "told", email: "bob@example.com", name: "Bob" } },
      { roomRequest: { id: "q1", phase: "result" } },
      { comm: { groupId: "g1", withBotId: "b2", withName: "Ada", withColor: "blue" } },
      { threadRef: { botId: "b1", threadId: "th2", title: "Side job" } },
      { kind: "text" },
    ];
    for (const extra of rows) {
      const message = step(long, extra);
      expect(pageMessage(message)).toBe(message);
    }
  });

  it("still drops a screen's picture", () => {
    const screen = { id: "s1", role: "bot", kind: "screen", at: 1, text: "", png: "iVBOR" } as Message;
    expect(pageMessage(screen)).toEqual({ id: "s1", role: "bot", kind: "screen", at: 1, text: "", hasImage: true });
  });
});

describe("fitMessages", () => {
  const row = (id: string, text: string) => ({ id, text });

  it("returns a short page unchanged", () => {
    const messages = [row("1", "hi"), row("2", "there")];
    expect(fitMessages(messages, 10_000, false)).toEqual({ messages, hasMore: false });
  });

  it("keeps the newest rows that fit and marks the dropped older ones", () => {
    const messages = ["0", "1", "2", "3", "4"].map((id) => row(id, "x".repeat(40)));
    const budget = jsonUtf8Size(messages.slice(-2)) + 8;
    const fitted = fitMessages(messages, budget, false);
    expect(jsonUtf8Size(fitted.messages)).toBeLessThanOrEqual(budget);
    expect(fitted.messages.at(-1)?.id).toBe("4");
    expect(fitted.messages.length).toBeLessThan(messages.length);
    expect(fitted.hasMore).toBe(true);
    expect(messages[0]?.text).toHaveLength(40);
  });

  it("keeps the anchored row when the page is a window", () => {
    const messages = ["a", "b", "c", "d", "e"].map((id) => row(id, id.repeat(30)));
    const around = jsonUtf8Size(messages.slice(1, 4));
    const fitted = fitMessages(messages, around, false, 2);
    expect(fitted.messages.map((message) => message.id)).toContain("c");
    expect(fitted.messages.map((message) => message.id)).not.toContain("a");
    expect(jsonUtf8Size(fitted.messages)).toBeLessThanOrEqual(around);
    expect(fitted.hasMore).toBe(true);
  });

  it("clips one oversized row without changing the stored message", () => {
    const original = row("huge", "z".repeat(400));
    const fitted = fitMessages([original], 80, false);
    expect(original.text).toHaveLength(400);
    expect(jsonUtf8Size(fitted.messages)).toBeLessThanOrEqual(80);
    expect(fitted.hasMore).toBe(true);
    if (fitted.messages[0]) expect(fitted.messages[0].text.length).toBeLessThan(400);
  });
});

describe("fitRosterPayload", () => {
  it("drops the oldest rows of the heaviest pages until the document fits", () => {
    const page = (id: string) => ({
      id,
      messages: [0, 1, 2, 3].map((index) => ({ id: `${id}-${index}`, text: "x".repeat(50) })),
      hasMore: false,
    });
    const payload = { bots: [page("a"), page("b")], groups: [page("g")], note: "kept" };
    const oneEach = {
      ...payload,
      bots: payload.bots.map((owner) => ({ ...owner, messages: owner.messages.slice(-1), hasMore: true })),
      groups: payload.groups.map((owner) => ({ ...owner, messages: owner.messages.slice(-1), hasMore: true })),
    };
    // The fitter reserves a few bytes per conversation for the hasMore it sets while dropping rows.
    const budget = jsonUtf8Size(oneEach) + 512;
    const fitted = fitRosterPayload(structuredClone(payload), budget);
    expect(jsonUtf8Size(fitted)).toBeLessThanOrEqual(budget);
    expect(fitted.note).toBe("kept");
    expect(fitted.bots.map((owner) => owner.messages.at(-1)?.id)).toEqual(["a-3", "b-3"]);
    expect(fitted.groups[0]?.messages.at(-1)?.id).toBe("g-3");
    const counts = [...fitted.bots, ...fitted.groups].map((owner) => owner.messages.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(fitted.bots.every((owner) => owner.hasMore)).toBe(true);
    expect(payload.bots[0]?.messages).toHaveLength(4);
  });
});
