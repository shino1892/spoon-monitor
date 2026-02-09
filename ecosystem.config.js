module.exports = {
  apps: [
    {
      name: "spoon-monitor",
      script: "pnpm",
      args: "tsx monitor.ts", // 監視用
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "spoon-manager",
      script: "pnpm",
      args: "tsx manager.ts", // Discord操作・更新用
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
