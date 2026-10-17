import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.markrai.sisutrainer", // historical; appId change deferred to Phase 5B.2
  appName: "FitBaus Trainer",
  webDir: "www",
  plugins: {
    SystemBars: {
      hidden: true,
      style: "DARK",
      insetsHandling: "css",
    },
  },
};

export default config;
