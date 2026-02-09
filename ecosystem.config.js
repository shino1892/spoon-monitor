module.exports = {
  apps: [
    {
      name: "spoon-monitor",
      script: "pnpm tsx monitor.ts",
      autorestart: true,
    },
    {
      name: "spoon-manager",
      script: "pnpm tsx manager.ts",
      autorestart: true,
    },
  ],
};
