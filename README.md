# spoon-monitor

## 重要: 配信検知はオンデマンド化

Spoon 運営からの警告に合わせ、常時の配信検知（定期リクエスト）を避けるため、配信検知は Discord のスラッシュコマンド `/check` 実行時のみ行います。

- `/check` 実行後、最大30秒間だけ 2秒ごとに Spoon API を叩いて「配信中/配信なし」を返します（ephemeral 返信）
- 検知のみ（collector の自動起動はしません）

PM2 定義は [ecosystem.config.js](ecosystem.config.js) を参照してください（`spoon-app` はデフォルトでコメントアウトされています）。

## 構成

- [src/app.ts](src/app.ts)：共通ログイン処理（`initSpoon`）
- [src/spoon/monitor.ts](src/spoon/monitor.ts)：（レガシー）常時監視プロセス（collector 起動担当）
- [src/spoon/collector.ts](src/spoon/collector.ts)：配信中の収集・保存プロセス
- [src/discord/bot.ts](src/discord/bot.ts)：Discord 管理 Bot（Slash Command）プロセス

## 前提

- Node.js（`tsx` が動くバージョン）
- `pnpm`
- `pm2`（常駐運用する場合）
- PostgreSQL（配信レポート保存用）
- Discord Bot（通知・管理コマンド用）

### SOPIA 依存について

`package.json` の `@sopia-bot/core` はローカル参照です。既存の SOPIA プロジェクト配置が必要な場合があります。

## セットアップ

### 1) 依存関係インストール

```bash
pnpm install
```

### 2) `.env` を作成

`.env.example` を参考に `.env` を作成してください。

最低限 `/check` で検知する場合は以下が必要です。

```env
DJ_ID=
MONITOR_ACCESS_TOKEN=
MONITOR_REFRESH_TOKEN=

DISCORD_BOT_TOKEN=
ADMIN_ID=

# 任意（反映が速いギルド登録を使う場合）
DISCORD_GUILD_ID=

# 推奨（BotのApplication ID。無くても動く場合があります）
DISCORD_APP_ID=
```

## 起動方法

### 開発/単体起動（PM2なし）

Discord 管理 Bot:

```bash
pnpm tsx src/discord/bot.ts
```

### PM2 運用

起動:

```bash
pm2 start ecosystem.config.js
pm2 save
```

ログ:

```bash
pm2 logs spoon-manager
```

## 使い方（Discord Slash Commands）

管理者（`ADMIN_ID`）のみ利用可能:

- `/check`：最大30秒・2秒間隔で配信状況をチェック（オンデマンド検知）
- `/status`：PM2 上の `spoon-app` の状態を表示（※ `spoon-app` を有効化している場合のみ）
- `/lastsummary`：`data/` 配下の最新 `summary.json` の概要を表示
- `/restart confirm:true`：`spoon-app` を再起動（※ `spoon-app` を有効化している場合のみ）

## データ

- `data/<timestamp>_<title>/summary.json` に配信サマリーを保存します。
- Discord の `/lastsummary` はこのファイルを参照して概要を返します。

## 運用メモ

- `.env` にはアクセストークン/リフレッシュトークンが含まれます。誤ってコミットしないでください。
