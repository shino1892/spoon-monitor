module.exports = {
  apps: [
    {
      name: "spoon-manager",
      script: "pnpm",
      args: "pnpm tsx src/discord/bot.ts", // Discord操作・更新用
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
