import { buildEntryAutoReply, buildJoinLogMessage, buildLeaveLogMessage, buildReJoinLogMessage, EntryCategory } from "./messages";

export interface UserActivity {
  userId: number;
  nickname: string;
  accountAge: string;
  fanRank: number;
  firstSeen: string;
  lastSeen: string;
  staySeconds: number;
  entryCount: number;
  counts: { chat: number; heart: number; spoon: number };
}

export interface CollectorState {
  userStats: Map<number, UserActivity>;
  currentListeners: Set<number>;
  allTimeSeenUserIds: Set<number>;
  totalLikes: number;
}

interface HandleEntryOptions {
  forceRejoin?: boolean;
}

interface RawUser {
  id?: number;
  userId?: number;
  nickname?: string;
  date_joined?: string;
  dateJoined?: string;
  fan_rank?: number;
}

function resolveUserId(user: RawUser): number | null {
  const userId = user.id ?? user.userId;
  if (userId === undefined || userId === null) return null;
  const n = Number(userId);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function createCollectorState(allTimeSeenUserIds: Iterable<number> = []): CollectorState {
  return {
    userStats: new Map<number, UserActivity>(),
    currentListeners: new Set<number>(),
    allTimeSeenUserIds: new Set<number>(allTimeSeenUserIds),
    totalLikes: 0,
  };
}

export function handleEntry(state: CollectorState, user: RawUser, nowISO: string, options: HandleEntryOptions = {}): { userId: number; stats: UserActivity; joinMessage?: string; leaveMessage?: string; reJoinMessage?: string; entryAutoReplyMessage?: string } | null {
  const userId = resolveUserId(user);
  if (userId === null) return null;

  if (!state.userStats.has(userId)) {
    // この配信中で初登場のユーザーを初期化する。
    const hasVisitedAnyLiveBefore = state.allTimeSeenUserIds.has(userId);
    const stats: UserActivity = {
      userId,
      nickname: user.nickname || "リスナー",
      accountAge: user.date_joined || user.dateJoined || "",
      fanRank: user.fan_rank || 0,
      firstSeen: nowISO,
      lastSeen: nowISO,
      staySeconds: 0,
      entryCount: 1,
      counts: { chat: 0, heart: 0, spoon: 0 },
    };
    state.userStats.set(userId, stats);
    state.currentListeners.add(userId);
    state.allTimeSeenUserIds.add(userId);

    const category: EntryCategory = hasVisitedAnyLiveBefore ? "first-in-live" : "first-ever";
    return {
      userId,
      stats,
      joinMessage: buildJoinLogMessage(stats.nickname),
      entryAutoReplyMessage: buildEntryAutoReply(stats.nickname, category),
    };
  }

  const stats = state.userStats.get(userId)!;
  const shouldForceRejoin = options.forceRejoin === true;
  let reJoinMessage: string | undefined;
  let leaveMessage: string | undefined;
  let entryAutoReplyMessage: string | undefined;
  if (!state.currentListeners.has(userId) || shouldForceRejoin) {
    // 直前スナップショットに不在だった場合は再入室として扱う。
    if (shouldForceRejoin && state.currentListeners.has(userId)) {
      // ポーリング間の退室見逃しを、明示的な入室イベントで補完する。
      leaveMessage = buildLeaveLogMessage(stats.nickname || userId);
    }
    stats.entryCount++;
    stats.lastSeen = nowISO;
    reJoinMessage = buildReJoinLogMessage(stats.nickname, stats.entryCount);
    if (stats.entryCount === 2) {
      entryAutoReplyMessage = buildEntryAutoReply(stats.nickname, "second-entry");
    }
  }

  state.currentListeners.add(userId);
  return { userId, stats, leaveMessage, reJoinMessage, entryAutoReplyMessage };
}

export function applyPollingSnapshot(state: CollectorState, latestListeners: RawUser[], nowISO: string, pollIntervalMs: number): { messages: string[]; entryAutoReplyMessages: string[] } {
  const latestIds = new Set<number>();
  const messages: string[] = [];
  const entryAutoReplyMessages: string[] = [];

  latestListeners.forEach((user) => {
    const entryResult = handleEntry(state, user, nowISO);
    if (!entryResult) return;

    if (entryResult.joinMessage) messages.push(entryResult.joinMessage);
    if (entryResult.leaveMessage) messages.push(entryResult.leaveMessage);
    if (entryResult.reJoinMessage) messages.push(entryResult.reJoinMessage);
    if (entryResult.entryAutoReplyMessage) entryAutoReplyMessages.push(entryResult.entryAutoReplyMessage);

    latestIds.add(entryResult.userId);
    entryResult.stats.staySeconds += pollIntervalMs / 1000;
    entryResult.stats.lastSeen = nowISO;
    if (!entryResult.stats.accountAge && user.date_joined) {
      entryResult.stats.accountAge = user.date_joined;
    }
  });

  state.currentListeners.forEach((id) => {
    // 最新一覧から消えたユーザーは退室ログを作成する。
    if (!latestIds.has(id)) {
      const stats = state.userStats.get(id);
      messages.push(buildLeaveLogMessage(stats?.nickname || id));
    }
  });

  state.currentListeners = latestIds;
  return { messages, entryAutoReplyMessages };
}

export function addChat(stats: UserActivity) {
  stats.counts.chat++;
}

export function addLike(state: CollectorState, stats: UserActivity, likeCount: number) {
  stats.counts.heart += likeCount;
  state.totalLikes += likeCount;
}

export function addDonation(stats: UserActivity, amount: number) {
  stats.counts.spoon += amount;
}
