export type EntryCategory = "first-ever" | "first-in-live" | "second-entry";

export function buildEntryAutoReply(nickname: string, category: EntryCategory) {
  if (category === "first-ever") return `はじめまして！${nickname}さん、いらっしゃい！`;
  if (category === "first-in-live") return `${nickname}さん、いらっしゃい！`;
  return `${nickname}さん、おかえりなさい！`;
}

export function buildJoinLogMessage(nickname: string) {
  return `[Join] ${nickname} (初回入室)`;
}

export function buildReJoinLogMessage(nickname: string, entryCount: number) {
  return `[Re-join] ${nickname} (累計: ${entryCount}回)`;
}

export function buildLeaveLogMessage(nicknameOrId: string | number) {
  return `[Leave] ${nicknameOrId} が退室しました`;
}

export function buildChatMetricLogMessage(message: string) {
  return `「${message}」を受信しました。`;
}

export function buildLikeMetricLogMessage(likeCount: number) {
  return `ハート数：${likeCount}`;
}

export function buildDonationMetricLogMessage(amount: number) {
  return `${amount}スプーンをもらいました。`;
}

export function buildLikeAutoReply(nickname: string, likeCount: number) {
  const namePrefix = `${nickname}\n`;
  // 1 回目だけ特別な文面にして反応率を上げる。
  if (likeCount === 1) return `ハートありがとう。${namePrefix}のこと解析してもいい？`; //ひなが考えたやつ
  // 連打時は閾値で短文テンプレートを切り替える。
  if (likeCount < 10) return `${namePrefix}ミニバスターありがとう！`;
  return `${namePrefix}バスターありがとう！`;
}
