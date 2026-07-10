module.exports = {
  apps: [
    {
      name: "spoon-manager",
      script: "pnpm",
      args: "tsx src/discord/bot.ts", // Discord操作・更新用
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "refresh-listener-temperatures",
      script: "pnpm",
      args: "tsx src/jobs/refresh-listener-temperatures.ts",
      cron_restart: "0 4 * * *",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
    // 🆕 追加: トークンレシーバーサーバー
    {
      name: "token-receiver",
      script: "pnpm",
      args: "tsx src/server.ts", // レシーバーサーバーのファイルパス（環境に合わせて調整してください）
      autorestart: true,         // サーバーなので落ちたら自動再起動する
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: 5000,
      },
    },
  ],
};