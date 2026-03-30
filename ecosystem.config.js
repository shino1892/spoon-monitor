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
  ],
};
