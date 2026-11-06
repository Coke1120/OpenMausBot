import type { Message, Store } from "../store.ts";
import { toolResultPrefix } from "../tool-results.ts";

const MESSAGE_PAGE_MAX = 200;
/** Bytes the desktop companion buffers while scrubbing one JSON response (`MAX_JSON_BODY_BYTES` in companion/src/proxy.ts). */
export const COMPANION_JSON_BODY_LIMIT = 32 * 1024 * 1024;
/** Headroom under that ceiling: the proxy re-serializes the scrubbed document before forwarding it. */
export const ROSTER_JSON_BUDGET = 24 * 1024 * 1024;
/** How much of a tool step's output a conversation page carries: the rest is fetched when the step is opened, so
 * switching to a conversation full of tool steps stays light. */
export const TOOL_OUTPUT_PREVIEW = 1_000;

/** undefined = absent, null = present but unusable (the caller answers 400). */
export function pageSize(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 0) return null;
  return Math.min(size, MESSAGE_PAGE_MAX);
}

export function slimMessage(message: Message): Message | Record<string, unknown> {
  if (message.kind !== "screen" || !message.png) return message;
  const { png: _png, ...rest } = message;
  return { ...rest, hasImage: true };
}

/** A message as a conversation page carries it: slimmed, and a plain tool step's long output cut to a preview marked
 * `clipped`. Input stays whole (labels parse it), and so do rows whose tool output is the reply itself (a teammate's
 * result, a relayed message, a handoff). */
export function pageMessage(message: Message): Message | Record<string, unknown> {
  const slim = slimMessage(message);
  const tool = message.tool;
  if (!tool || message.kind !== "activity" || message.relay || message.roomRequest || message.comm || message.threadRef) return slim;
  const output = tool.output;
  if (output === undefined || output.length <= TOOL_OUTPUT_PREVIEW) return slim;
  return { ...slim, tool: { ...tool, output: toolResultPrefix(output, TOOL_OUTPUT_PREVIEW), clipped: true } };
}

export function jsonUtf8Size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function rangedSize(sizes: readonly number[], start: number, end: number): number {
  const count = end - start;
  if (count <= 0) return 2;
  let total = 2 + count - 1;
  for (let i = start; i < end; i++) total += sizes[i]!;
  return total;
}

function clipMessage<T>(message: T, budget: number): T {
  if (budget < 2 || jsonUtf8Size(message) <= budget) return message;
  if (!message || typeof message !== "object") return message;
  const copy = structuredClone(message) as Record<string, unknown>;
  const targets: Array<{ holder: Record<string, unknown>; key: string; value: string }> = [];
  const consider = (holder: Record<string, unknown>) => {
    for (const key of ["text", "output", "input"]) {
      const value = holder[key];
      if (typeof value === "string" && value.length > 0) targets.push({ holder, key, value });
    }
  };
  consider(copy);
  if (copy.tool && typeof copy.tool === "object") consider(copy.tool as Record<string, unknown>);
  targets.sort((a, b) => b.value.length - a.value.length);
  for (const target of targets) {
    if (jsonUtf8Size(copy) <= budget) break;
    let best = 0;
    let low = 0;
    let high = target.value.length;
    while (low <= high) {
      const mid = (low + high) >> 1;
      target.holder[target.key] = mid === 0 ? "" : toolResultPrefix(target.value, mid);
      if (jsonUtf8Size(copy) <= budget) {
        best = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    target.holder[target.key] = best === 0 ? "" : toolResultPrefix(target.value, best);
    if (target.key !== "text") target.holder.clipped = true;
  }
  return copy as T;
}

/** Newest rows that fit in `budget` JSON bytes, or the rows around `anchor` when one is given. Stored rows are not changed. */
export function fitMessages<T>(
  messages: readonly T[],
  budget: number,
  hasMore: boolean,
  anchor = messages.length - 1,
): { messages: T[]; hasMore: boolean } {
  if (messages.length === 0 || budget < 2) return { messages: [], hasMore: hasMore || messages.length > 0 };
  const sizes = messages.map((message) => jsonUtf8Size(message));
  if (rangedSize(sizes, 0, sizes.length) <= budget) return { messages: [...messages], hasMore };
  const index = Math.min(sizes.length - 1, Math.max(0, anchor));
  if (rangedSize(sizes, index, index + 1) > budget) {
    const clipped = clipMessage(messages[index], budget - 2);
    if (jsonUtf8Size(clipped) + 2 <= budget) return { messages: [clipped], hasMore: true };
    return { messages: [], hasMore: true };
  }
  let lo = index;
  let hi = index;
  let grew = true;
  while (grew) {
    grew = false;
    if (lo > 0 && rangedSize(sizes, lo - 1, hi + 1) <= budget) {
      lo--;
      grew = true;
    }
    if (hi + 1 < sizes.length && rangedSize(sizes, lo, hi + 2) <= budget) {
      hi++;
      grew = true;
    }
  }
  return { messages: messages.slice(lo, hi + 1), hasMore: hasMore || lo > 0 };
}

interface RosterPage {
  messages?: unknown[];
  hasMore?: boolean;
}

/** Shrinks every conversation's page until the whole roster document fits. Metadata stays; only page rows are dropped or clipped. */
export function fitRosterPayload<T extends { bots: RosterPage[]; groups: RosterPage[] }>(
  payload: T,
  budget = ROSTER_JSON_BUDGET,
): T {
  const initial = jsonUtf8Size(payload);
  if (initial <= budget) return payload;
  const pages = [...payload.bots, ...payload.groups].flatMap((owner) => {
    const messages = owner.messages;
    if (!Array.isArray(messages) || messages.length === 0) return [];
    return [{ owner, messages, sizes: messages.map((message) => jsonUtf8Size(message)), start: 0 }];
  });
  const pageBytes = (page: (typeof pages)[number]) => rangedSize(page.sizes, page.start, page.messages.length);
  let messageBytes = pages.reduce((sum, page) => sum + pageBytes(page), 0);
  const overhead = initial - messageBytes;
  // Dropping a row sets hasMore, which can add a few bytes the message-array estimate does not include.
  const allowance = budget - overhead - 32 * (payload.bots.length + payload.groups.length + 1);
  if (allowance < 2) {
    for (const page of pages) {
      page.owner.messages = [];
      page.owner.hasMore = true;
    }
    return payload;
  }
  const steps = pages.reduce((sum, page) => sum + page.messages.length, 0) + pages.length;
  for (let guard = 0; messageBytes > allowance && guard < steps; guard++) {
    let victim: (typeof pages)[number] | undefined;
    let heaviest = -1;
    for (const page of pages) {
      if (page.start >= page.messages.length) continue;
      const bytes = pageBytes(page);
      if (bytes > heaviest) {
        heaviest = bytes;
        victim = page;
      }
    }
    if (!victim) break;
    const left = victim.messages.length - victim.start;
    if (left === 1) {
      const others = messageBytes - pageBytes(victim);
      const room = allowance - others;
      const newest = victim.messages.length - 1;
      const clipped = clipMessage(victim.messages[newest], Math.max(0, room - 2));
      const clippedSize = jsonUtf8Size(clipped);
      if (clippedSize < victim.sizes[newest]! && clippedSize + 2 <= Math.max(0, room)) {
        victim.messages[newest] = clipped;
        victim.sizes[newest] = clippedSize;
      } else victim.start = victim.messages.length;
    } else victim.start += 1;
    messageBytes = pages.reduce((sum, page) => sum + pageBytes(page), 0);
  }
  for (const page of pages) {
    if (page.start > 0) {
      page.owner.messages = page.messages.slice(page.start);
      page.owner.hasMore = true;
    }
  }
  let size = jsonUtf8Size(payload);
  for (let extra = 0; size > budget && extra < pages.length; extra++) {
    let victim: RosterPage | undefined;
    let heaviest = -1;
    for (const owner of [...payload.bots, ...payload.groups]) {
      const messages = owner.messages;
      if (!messages?.length) continue;
      const bytes = jsonUtf8Size(messages);
      if (bytes > heaviest) {
        heaviest = bytes;
        victim = owner;
      }
    }
    if (!victim?.messages?.length) break;
    victim.messages = victim.messages.slice(1);
    victim.hasMore = true;
    size = jsonUtf8Size(payload);
  }
  if (size > budget) {
    for (const page of pages) {
      if ((page.owner.messages?.length ?? 0) > 0) {
        page.owner.messages = [];
        page.owner.hasMore = true;
      }
    }
  }
  return payload;
}

function boundPage<T>(messages: readonly T[], hasMore: boolean, activeLeafId: string | null, anchor?: number) {
  const fitted = fitMessages(messages, ROSTER_JSON_BUDGET, hasMore, anchor);
  return { messages: fitted.messages, hasMore: fitted.hasMore, activeLeafId };
}

/** A conversation's messages one page at a time (newest first when `before` is absent), and the page around one message. */
export function messagePages(store: Pick<Store, "messagesFor" | "messagesTail" | "activeLeaf">) {
  function messagePage(threadId: string, limit: number | undefined, before?: string | null) {
    if (limit === undefined) {
      return { messages: store.messagesFor(threadId), activeLeafId: store.activeLeaf(threadId) };
    }
    if (!before) {
      const tail = store.messagesTail(threadId, limit);
      return boundPage(tail.messages.map(pageMessage), tail.hasMore, tail.activeLeafId);
    }
    const all = store.messagesFor(threadId);
    const end = all.findIndex((msg) => msg.id === before);
    const stop = end === -1 ? all.length : end;
    const start = Math.max(0, stop - limit);
    return boundPage(all.slice(start, stop).map(pageMessage), start > 0, store.activeLeaf(threadId));
  }

  function messageWindow(threadId: string, messageId: string, limit: number) {
    const all = store.messagesFor(threadId);
    const index = all.findIndex((message) => message.id === messageId);
    if (index < 0) return null;
    const before = Math.floor((limit - 1) / 2);
    const start = Math.max(0, Math.min(index - before, all.length - limit));
    const stop = Math.min(all.length, start + limit);
    const fitted = fitMessages(all.slice(start, stop).map(pageMessage), ROSTER_JSON_BUDGET, start > 0, index - start);
    return { messages: fitted.messages, hasMore: fitted.hasMore };
  }

  return { messagePage, messageWindow };
}
