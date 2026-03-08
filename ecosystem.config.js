module.exports = {
  apps: [
    {
      name: "spoon-app",
      script: "pnpm",
      args: "tsx src/spoon/monitor.ts", // 監視(検知) + collector起動
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        // 開始検知はMONITORアカウント（購読一覧）で行う
        DETECT_ACCOUNT: "MONITOR",
        // 運用デフォルトでは診断ログを抑制（必要時だけ pm2 restart --update-env で上書き）
        DIAG_DETECT: "0",
        DIAG_COMPARE_CLIENTS: "0",
        DJ_DETECT_FALLBACK_MONITOR: "0",
      },
    },
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
      name: "spoon-admin",
      script: "src/admin/server.ts",
      interpreter: "node",
      interpreter_args: "--import tsx", // tsx を直接インポートして実行
      cwd: "/root/workspaces/spoon-monitor/spoon-monitor",
      env: {
        PORT: 3000
      }
    }
  ],
};
