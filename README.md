# spoon-monitor

## 目的

Spoon への常時スクレイピング/定期ポーリングを避けるため、配信検知は Discord のスラッシュコマンド `/check` 実行時のみ行います。

`/check` 実行後、最大30秒間だけ 2秒ごとに Spoon API へリクエストして「配信中/配信なし」を返します（検知通知のみ。collector の自動起動はしません）。

## 起動（PM2）

このプロジェクトは `spoon-manager`（Discord bot）のみ常駐します。

- `pm2 start ecosystem.config.js`
- `pm2 logs spoon-manager`

## Discord コマンド

### `/check`

- 実行すると、最大30秒・2秒間隔で配信状況をチェックします（ephemeral で返信）
- 実行できるのは `ADMIN_ID` のユーザーのみです

### `!update monitor <token>`

- `.env` の `MONITOR_TOKEN` を更新します
- 更新後は再起動なしで `/check` に反映されます

## 必要な環境変数（.env）

- `DISCORD_BOT_TOKEN`
- `DISCORD_CHANNEL_ID`
- `DISCORD_GUILD_ID`（`/check` を登録したいサーバーID）
- `ADMIN_ID`
- `DJ_ID`
- `MONITOR_TOKEN`

（参考）既存の収集機能を使う場合は `COLLECTOR_TOKEN` も必要です。
