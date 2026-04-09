# spoon-monitor

## 重要: 配信検知はオンデマンド化

Spoon 運営からの警告に合わせ、常時の配信検知（定期リクエスト）を避けるため、配信検知は Discord のスラッシュコマンド実行時のみ行います。

- `/check` 実行後、最大30秒間だけ 2秒ごとに Spoon API を叩いて「配信中/配信なし」を返します（ephemeral 返信）
- `/join` 実行時は同じ検知を行い、配信中なら join + collector 起動を行います
- `/leave` 実行時は退室 + collector 停止を行います

PM2 定義は [ecosystem.config.js](ecosystem.config.js) を参照してください。

## 構成

- [src/app.ts](src/app.ts)：共通ログイン処理（`initSpoon`）
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

`/join` で join + collector まで使う場合は、以下も設定してください。

```env
DJ_ACCESS_TOKEN=
DJ_REFRESH_TOKEN=
```

日次バッチ（`refresh-listener-temperatures`）を使う場合は DB 接続情報も必要です。

```env
DB_HOST=
DB_USER=
DB_PASSWORD=
DB_NAME=
DB_PORT=
```

## 起動方法

### 開発/単体起動（PM2なし）

Discord 管理 Bot:

```bash
pnpm tsx src/discord/bot.ts
```

## トークン更新API（Chrome拡張 → サーバー）

Chrome拡張から送られてくるトークンを受け取り、`data/tokens.json` に保存します。
`src/app.ts` の `initSpoon()` はこのファイルの内容を優先して参照するため、`.env` の値を「再起動なし」で上書きできます（次回ログイン処理から反映）。

### 起動（このリポジトリ内）

依存関係の追加（未インストールなら）:

```bash
pnpm install
pnpm add express cors
```

起動（ポート5000固定）:

```bash
pnpm token-server
```

### 起動（最小構成の手順 / npm 例）

別プロジェクトに切り出して使う場合の参考手順です。

```bash
npm init -y
npm i express cors
node token-server.js
```

### API

- `GET /health`
  - レスポンス: `{ "ok": true }`

- `POST /update-token`
  - Content-Type: `application/json`
  - ボディ:
    ```json
    {
    	"Token": "string",
    	"refreshToken": "string",
    	"account": "Monitor" | "DJ" | "A" | "B"
    }
    ```
  - バリデーション
    - `Token` / `refreshToken` / `account` は必須
    - すべて `string`
    - `account` は `Monitor` / `DJ` / `A` / `B` のみ
    - `A -> Monitor`, `B -> DJ` にマッピングして保存
  - 成功レスポンス:
    - `{ "ok": true, "account": "Monitor" | "DJ", "updatedAt": "ISO8601" }`
  - エラー:
    - 不正入力: `400`（メッセージ付き）
    - 例外: `500`

### 保存形式

保存先: `./data/tokens.json`（なければ作成）

```json
{
  "Monitor": {
    "Token": "...",
    "refreshToken": "...",
    "updatedAt": "2026-04-09T00:00:00.000Z"
  },
  "DJ": {
    "Token": "...",
    "refreshToken": "...",
    "updatedAt": "2026-04-09T00:00:00.000Z"
  }
}
```

### curl 動作確認

正常系（Monitorに保存）:

```bash
curl -sS -X POST http://localhost:5000/update-token \
	-H "Content-Type: application/json" \
	-d '{"Token":"ACCESS_TOKEN_VALUE","refreshToken":"REFRESH_TOKEN_VALUE","account":"Monitor"}'
```

正常系（A -> Monitor にマッピング）:

```bash
curl -sS -X POST http://localhost:5000/update-token \
	-H "Content-Type: application/json" \
	-d '{"Token":"ACCESS_TOKEN_VALUE","refreshToken":"REFRESH_TOKEN_VALUE","account":"A"}'
```

異常系（account不正 → 400）:

```bash
curl -i -X POST http://localhost:5000/update-token \
	-H "Content-Type: application/json" \
	-d '{"Token":"x","refreshToken":"y","account":"Z"}'
```

異常系（Token欠落 → 400）:

```bash
curl -i -X POST http://localhost:5000/update-token \
	-H "Content-Type: application/json" \
	-d '{"refreshToken":"y","account":"Monitor"}'
```

### PM2 運用

起動:

```bash
pm2 start ecosystem.config.js
pm2 save
```

日次バッチ:

- `refresh-listener-temperatures` が毎日 04:00（サーバーローカル時刻）に `SELECT refresh_all_listener_temperatures();` を1回実行します。
- スケジュールは [ecosystem.config.js](ecosystem.config.js) の `cron_restart` で変更できます。

ログ:

```bash
pm2 logs spoon-manager
```

## 使い方（Discord Slash Commands）

管理者（`ADMIN_ID`）のみ利用可能:

- `/check`：最大30秒・2秒間隔で配信状況をチェック（オンデマンド検知）
- `/join`：最大30秒・2秒間隔で配信検知し、見つかれば配信に参加して collector を起動
- `/leave`：参加中の配信から退室し、collector を停止
- `/lastsummary`：`data/` 配下の最新 `summary.json` の概要を表示

## データ

- `data/<timestamp>_<title>/summary.json` に配信サマリーを保存します。
- Discord の `/lastsummary` はこのファイルを参照して概要を返します。

## 運用メモ

- `.env` にはアクセストークン/リフレッシュトークンが含まれます。誤ってコミットしないでください。
