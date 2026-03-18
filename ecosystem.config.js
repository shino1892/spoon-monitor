module.exports = {
  apps: [
    // NOTE: 常時監視（定期リクエスト）を避けるため、spoon-app はデフォルトでは起動しません。
    // 必要になった場合のみ、下の定義を有効化してください。
    // {
    //   name: "spoon-app",
    //   script: "pnpm",
    //   args: "tsx src/spoon/monitor.ts", // 監視(検知) + collector起動
    //   autorestart: true,
    //   watch: false,
    //   env: {
    //     NODE_ENV: "production",
    //     DETECT_ACCOUNT: "MONITOR",
    //     DIAG_DETECT: "0",
    //     DIAG_COMPARE_CLIENTS: "0",
    //     DJ_DETECT_FALLBACK_MONITOR: "0",
    //   },
    // },
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
  ],
};
