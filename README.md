# spoon-monitor

Spoon の配信を監視し、配信中のリスナー行動（入退室/チャット/ハート/スプーン等）を収集して保存し、Discord へ通知するための常駐監視ツールです。

本プロジェクトは既存の **SOPIA プロジェクト**（依存パッケージ `@sopia-bot/core`）を用いて開発しています。
また、コードの大半は **AI（GitHub Copilot 等）** が記述し、人間が要件整理・調整・レビューを行っています。

## 構成

- `src/app.ts`：共通ログイン処理（`initSpoon`）
- `src/spoon/monitor.ts`：配信検知プロセス（collector 起動担当）
- `src/spoon/collector.ts`：配信中の収集・保存プロセス
- `spoon-manager`：Discord 管理 Bot（Slash Command）プロセス（`tsx src/discord/bot.ts`）
- `spoon-admin`：管理用 Web（`.env` 編集 + PM2 再起動）プロセス（`src/admin/server.ts`）

PM2 定義は `ecosystem.config.js` を参照してください。

## 前提

- Node.js（`tsx` が動くバージョン）
- `pnpm`
- `pm2`（常駐運用する場合）
- PostgreSQL（配信レポート保存用）
- Discord Bot（通知・管理コマンド用）

### SOPIA 依存について

`package.json` の `@sopia-bot/core` はローカル参照（`file:../../spoon/packages/core`）です。
そのため、このリポジトリ単体ではインストールできず、既存の SOPIA プロジェクト配置が必要です。

## セットアップ

### 1) 依存関係インストール

```bash
pnpm install
```

### 2) `.env` を作成

`spoon-monitor/.env` を作成し、最低限以下を設定してください。

```env
# --- Spoon ---
DJ_ID=

# DJ アカウント（収集用）
DJ_ACCESS_TOKEN=
DJ_REFRESH_TOKEN=

# MONITOR アカウント（配信検知用・購読一覧から検知）
MONITOR_ACCESS_TOKEN=
MONITOR_REFRESH_TOKEN=

# --- Discord ---
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=

# 通知先: channel（既定） or dm
DISCORD_NOTIFY_MODE=channel

# dm 送信に使う管理者ID（任意: DISCORD_NOTIFY_MODE=dm の場合）
DISCORD_ADMIN_ID=

# spoon-manager（Slash Command）用
ADMIN_ID=
DISCORD_APP_ID=
# 任意: 特定Guildへ登録する場合
DISCORD_GUILD_ID=
```

オプション設定（必要になったときだけ）:

```env
# 監視・収集の間隔など
CHECK_INTERVAL=30000
LISTENER_POLL_INTERVAL=10000
END_CHECK_INTERVAL=15000

# Discord 通知の抑制（スパム防止）
DISCORD_ALERT_THROTTLE_MS=3600000

# @sopia-bot/core の HTTP デバッグ（Authorization が出る可能性があるため通常は無効推奨）
SOPIA_HTTP_DEBUG=0
```

### 3) PostgreSQL の準備

このプロジェクトは以下のテーブルを使用します（最低限）。

```sql
-- 配信レポート
CREATE TABLE IF NOT EXISTS live_reports (
	id BIGSERIAL PRIMARY KEY,
	live_id TEXT NOT NULL,
	title TEXT NOT NULL,
	dj_name TEXT NOT NULL,
	duration INTEGER NOT NULL,
	likes INTEGER NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- リスナー行動
CREATE TABLE IF NOT EXISTS listener_activities (
	id BIGSERIAL PRIMARY KEY,
	report_id BIGINT NOT NULL REFERENCES live_reports(id) ON DELETE CASCADE,
	user_id BIGINT NOT NULL,
	nickname TEXT,
	stay_seconds INTEGER NOT NULL,
	entry_count INTEGER NOT NULL,
	chat_count INTEGER NOT NULL,
	heart_count INTEGER NOT NULL,
	spoon_count INTEGER NOT NULL,
	first_seen TEXT,
	last_seen TEXT
);
```

注意: 一部の DB 接続設定はコード側で固定値（例: `192.168.0.56`）を使用しています。運用環境に合わせて `src/spoon/collector.ts` 等の DB 設定を調整してください。

## 起動方法

### 開発/単体起動（PM2なし）

監視（配信検知）:

```bash
pnpm tsx src/spoon/monitor.ts
```

Discord 管理 Bot:

```bash
pnpm tsx src/discord/bot.ts
```

管理 UI/API:

```bash
node --import tsx src/admin/server.ts
```

### PM2 運用

起動:

```bash
pm2 start ecosystem.config.js
pm2 save
```

再起動:

```bash
pm2 restart spoon-app
pm2 restart spoon-manager
pm2 restart spoon-admin
```

全体再起動:

```bash
pm2 restart all
```

## 使い方

### `spoon-app`

- `monitor.ts` が `DETECT_ACCOUNT`（既定: `MONITOR`）の購読一覧から、`DJ_ID` の配信開始/終了を検知します。
- 配信検知後に `collector.ts` を起動し、配信中の滞在/イベントを集計、終了時に DB 保存と Discord 通知を実行します。

### `spoon-manager`（Discord Slash Commands）

管理者（`ADMIN_ID`）のみ利用可能:

- `/status`：PM2 上の `spoon-app` の状態を表示
- `/lastsummary`：`data/` 配下の最新 `summary.json` の概要を表示
- `/restart confirm:true`：`spoon-app` を再起動

### `spoon-admin`（Web）

- `public/index.html` を配信し、`.env` の閲覧/編集と `pm2 restart all` を叩く API を提供します。
- 既定は `PORT=3000` で `0.0.0.0` バインドです。

## データ

- `data/<timestamp>_<title>/summary.json` に配信サマリーを保存します。
- Discord の `/lastsummary` はこのファイルを参照して概要を返します。

## 運用メモ

- `.env` にはアクセストークン/リフレッシュトークンが含まれます。誤ってコミットしないでください。
- `SOPIA_HTTP_DEBUG=1` は HTTP の詳細ログを出すため、Authorization がログに混ざる可能性があります（通常は無効推奨）。

