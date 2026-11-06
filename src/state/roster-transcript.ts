import { useEffect, useRef } from "react";
import { api, snapshotArrays } from "./api";
import { optimisticMessageId } from "./optimistic-send";
import { botOpensTo } from "./thread-navigation";
import type { Action, AppState, Bot, Group, Message } from "./store";

/** Messages per open thread and per scrollback page: the server's own page maximum. The roster itself asks for none. */
export const MESSAGE_PAGE_SIZE = 200;
export const ROSTER_PATH = "/api/bots?messages=0";

export function withoutTranscript<T extends { messages?: Message[]; hasMore?: boolean }>(bot: T): Omit<T, "messages" | "hasMore"> {
  const { messages: _messages, hasMore: _hasMore, ...settings } = bot;
  return settings;
}

export function snapshotSelection(
  selectedId: string,
  bots: ReadonlyArray<{ id: string; hidden?: boolean }>,
  groups: ReadonlyArray<{ id: string }>,
  resumeId: string | undefined,
): string {
  const known = (id: string) => bots.some((bot) => bot.id === id) || groups.some((group) => group.id === id);
  const resumed = resumeId && (bots.some((bot) => bot.id === resumeId && !bot.hidden) || groups.some((group) => group.id === resumeId)) ? resumeId : "";
  return selectedId && known(selectedId) ? selectedId : resumed || (bots[0]?.id ?? "");
}

function openTranscript(
  bots: readonly Bot[],
  groups: readonly Group[],
  threadsShown: boolean,
  selectedId: string,
): { owner: Bot | Group; bot?: Bot } | null {
  const group = groups.find((candidate) => candidate.id === selectedId);
  const bot = group ? undefined : bots.find((candidate) => candidate.id === selectedId);
  const owner = group ?? bot;
  if (!owner || (owner.messages?.length ?? 0) > 0 || !owner.hasMore || bot?.switchingTo) return null;
  if (bot && botOpensTo(bot, threadsShown) !== bot.threadId) return null;
  return { owner, bot };
}

function threadPagePath(threadId: string): string {
  return `/api/threads/${threadId}/messages?limit=${MESSAGE_PAGE_SIZE}`;
}

export async function attachOpenThread(bots: Bot[], groups: Group[], threadsShown: boolean, selectedId: string): Promise<void> {
  const found = openTranscript(bots, groups, threadsShown, selectedId);
  if (!found) return;
  try {
    const page = await api<{ messages?: Message[]; hasMore?: boolean; activeLeafId?: string | null }>(threadPagePath(found.owner.threadId));
    found.owner.messages = page.messages ?? [];
    found.owner.hasMore = Boolean(page.hasMore);
    if (found.bot && page.activeLeafId) found.bot.activeLeafId = page.activeLeafId;
  } catch {
    // The open-thread effect loads the tail while it is still empty.
  }
}

export async function prepareRoster(selectedId: string, threadsShown: boolean, resumeId: string | undefined) {
  const answer = await api(ROSTER_PATH);
  const { bots, groups = [], sections, computerControl, botQueuedMessages } = snapshotArrays(answer, "bots");
  await attachOpenThread(bots, groups, threadsShown, snapshotSelection(selectedId, bots, groups, resumeId));
  return { bots, groups, sections: sections ?? [], computerControl: computerControl ?? {}, botQueuedMessages };
}

export function applyThreadTail(state: AppState, action: Extract<Action, { type: "threadTail" }>): AppState {
  if ((state.transcriptGeneration[action.threadId] ?? 0) !== action.generation) return state;
  const pageIds = new Set(action.messages.map((message) => message.id));
  const pageSendIds = new Set(action.messages.flatMap((message) => (message.sendId ? [message.sendId] : [])));
  const oldest = action.messages[0]?.at;
  const merge = (messages: Message[]): { messages: Message[]; hasMore: boolean } | null => {
    const kept = messages.filter((message) => !pageIds.has(message.id) && !(message.sendId && pageSendIds.has(message.sendId) && message.id === optimisticMessageId(message.sendId)));
    if (kept.some((message) => oldest !== undefined && message.at < oldest && !message.id.startsWith("optimistic-"))) return null;
    return { messages: [...action.messages, ...kept], hasMore: action.hasMore };
  };
  let changed = false;
  const bots = state.bots.map((bot) => {
    if (bot.threadId !== action.threadId) return bot;
    const merged = merge(bot.messages ?? []);
    if (!merged) return bot;
    changed = true;
    return {
      ...bot,
      messages: merged.messages,
      hasMore: merged.hasMore,
      activeLeafId: (bot.messages?.length ?? 0) === 0 ? (action.activeLeafId ?? bot.activeLeafId) : bot.activeLeafId,
    };
  });
  const groups = state.groups.map((group) => {
    if (group.threadId !== action.threadId) return group;
    const merged = merge(group.messages ?? []);
    if (!merged) return group;
    changed = true;
    return { ...group, messages: merged.messages, hasMore: merged.hasMore };
  });
  return changed ? { ...state, bots, groups } : state;
}

export function useOpenThreadTail(state: AppState, threadsShown: boolean, dispatch: (action: Action) => void): void {
  const tailToken = useRef(0);
  const tailMounted = useRef(true);
  useEffect(() => {
    tailMounted.current = true;
    return () => { tailMounted.current = false; };
  }, []);
  const found = state.hydrated && state.selectedId ? openTranscript(state.bots, state.groups, threadsShown, state.selectedId) : null;
  const openTailThread = found?.owner.threadId ?? "";
  const openTailGeneration = found ? (state.transcriptGeneration[found.owner.threadId] ?? 0) : 0;
  useEffect(() => {
    if (!openTailThread) return;
    const token = ++tailToken.current;
    const threadId = openTailThread;
    const generation = openTailGeneration;
    void api<{ messages?: Message[]; hasMore?: boolean; activeLeafId?: string | null }>(threadPagePath(threadId)).then((page) => {
      if (!tailMounted.current || tailToken.current !== token) return;
      dispatch({
        type: "threadTail",
        threadId,
        generation,
        messages: page.messages ?? [],
        hasMore: Boolean(page.hasMore),
        activeLeafId: page.activeLeafId ?? null,
      });
    }).catch((error: unknown) => {
      if (!tailMounted.current || tailToken.current !== token) return;
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
  }, [dispatch, openTailThread, openTailGeneration]);
}
