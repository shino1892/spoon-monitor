import { v2 } from "@sopia-bot/core";
import { CollectorState, UserActivity, addChat, addDonation, addLike, handleEntry } from "./state";

const { EventName } = v2;

export const ROOM_CLOSE_EVENT_NAME = "RoomClose";

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
  let stats: UserActivity | undefined;

  if (event.userId !== undefined && Number.isFinite(event.userId)) {
    const entryResult = handleEntry(state, event.gen, nowISO);
    if (entryResult?.joinMessage) entryMessages.push(entryResult.joinMessage);
    if (entryResult?.reJoinMessage) entryMessages.push(entryResult.reJoinMessage);

    stats = state.userStats.get(event.userId);
    if (stats) stats.lastSeen = nowISO;
  }

  if (stats && event.eName === EventName.CHAT_MESSAGE) {
    addChat(stats);
    return {
      stats,
      entryMessages,
      metricLogMessage: `「${event.payload.message}」を受信しました。`,
    };
  }

  if (stats && isLikeEvent(event.eName)) {
    const likeCount = event.eName === EventName.LIVE_PAID_LIKE ? toPositiveInt(event.payload?.amount, 1) : toPositiveInt(event.payload?.count, 1);
    addLike(state, stats, likeCount);
    return {
      stats,
      likeCount,
      entryMessages,
      metricLogMessage: `ハート数：${likeCount}`,
    };
  }

  if (stats && event.eName === EventName.LIVE_DONATION) {
    const amount = event.payload.amount || 0;
    addDonation(stats, amount);
    return {
      stats,
      entryMessages,
      metricLogMessage: `${amount}スプーンをもらいました。`,
    };
  }

  return { stats, entryMessages };
}

export function createLikeAutoReply(nickname: string, likeCount: number) {
  const namePrefix = `${nickname}さん\n`;
  if (likeCount === 1) return `${namePrefix}ハートありがとう！`;
  if (likeCount < 10) return `${namePrefix}ミニバスターありがとう！`;
  return `${namePrefix}バスターありがとう！`;
}
