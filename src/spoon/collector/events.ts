import { v2 } from "@sopia-bot/core";
import { CollectorState, UserActivity, addChat, addDonation, addLike, handleEntry } from "./state";
import { buildChatMetricLogMessage, buildDonationMetricLogMessage, buildLikeAutoReply, buildLikeMetricLogMessage } from "./messages";

const { EventName } = v2;

export const ROOM_CLOSE_EVENT_NAME = "RoomClose";
export const NOOP_HANDLED_EVENT_NAMES = ["LivePlayMailboxStart", "LivePlayMailboxUpdate", "LivePlayMailbox", "LivePlayMailboxEnd", "LivePlayPollStart", "LivePlayPollUpdate", "LivePlayPollEnd"] as const;

export interface ParsedCollectorEvent {
  eName: string;
  payload: any;
  raw: any;
  gen: any;
  userId?: number;
  nickname: string;
  isSelf: boolean;
}

export interface ApplyEventResult {
  stats?: UserActivity;
  likeCount?: number;
  entryMessages: string[];
  entryAutoReplyMessages: string[];
  metricLogMessage?: string;
}

export function parseCollectorEvent(eventName: any, payload: any, raw: any, djId?: string): ParsedCollectorEvent {
  const eName = String(eventName);
  const gen = payload?.generator || payload?.author || payload?.user || payload;
  const extractedUserId = gen?.id ?? gen?.userId ?? payload?.userId ?? payload?.memberId ?? payload?.authorId;
  const userId = extractedUserId !== undefined && extractedUserId !== null ? Number(extractedUserId) : undefined;
  const nickname = gen?.nickname || payload?.nickname || "リスナー";
  const isSelf = userId !== undefined && !!djId && userId.toString() === djId;

  return {
    eName,
    payload,
    raw,
    gen,
    userId,
    nickname,
    isSelf,
  };
}

export function isLikeEvent(eName: string) {
  return eName === EventName.LIVE_FREE_LIKE || eName === EventName.LIVE_PAID_LIKE;
}

export function applyEventToState(state: CollectorState, event: ParsedCollectorEvent, nowISO: string, toPositiveInt: (value: unknown, fallback?: number) => number): ApplyEventResult {
  const entryMessages: string[] = [];
  const entryAutoReplyMessages: string[] = [];
  let stats: UserActivity | undefined;

  // Mailbox/Poll 系イベントは現在は観測のみ（将来ここに処理を追加する）
  if (NOOP_HANDLED_EVENT_NAMES.includes(event.eName as (typeof NOOP_HANDLED_EVENT_NAMES)[number])) {
    return { stats, entryMessages, entryAutoReplyMessages };
  }

  if (event.userId !== undefined && Number.isFinite(event.userId)) {
    const entryResult = handleEntry(state, event.gen, nowISO);
    if (entryResult?.joinMessage) entryMessages.push(entryResult.joinMessage);
    if (entryResult?.reJoinMessage) entryMessages.push(entryResult.reJoinMessage);
    if (entryResult?.entryAutoReplyMessage) entryAutoReplyMessages.push(entryResult.entryAutoReplyMessage);

    stats = state.userStats.get(event.userId);
    if (stats) stats.lastSeen = nowISO;
  }

  if (stats && event.eName === EventName.CHAT_MESSAGE) {
    addChat(stats);
    return {
      stats,
      entryMessages,
      entryAutoReplyMessages,
      metricLogMessage: buildChatMetricLogMessage(event.payload.message),
    };
  }

  if (stats && isLikeEvent(event.eName)) {
    const likeCount = event.eName === EventName.LIVE_PAID_LIKE ? toPositiveInt(event.payload?.amount, 1) : toPositiveInt(event.payload?.count, 1);
    addLike(state, stats, likeCount);
    return {
      stats,
      likeCount,
      entryMessages,
      entryAutoReplyMessages,
      metricLogMessage: buildLikeMetricLogMessage(likeCount),
    };
  }

  if (stats && event.eName === EventName.LIVE_DONATION) {
    const amount = event.payload.amount || 0;
    addDonation(stats, amount);
    return {
      stats,
      entryMessages,
      entryAutoReplyMessages,
      metricLogMessage: buildDonationMetricLogMessage(amount),
    };
  }

  return { stats, entryMessages, entryAutoReplyMessages };
}

export function createLikeAutoReply(nickname: string, likeCount: number) {
  return buildLikeAutoReply(nickname, likeCount);
}
