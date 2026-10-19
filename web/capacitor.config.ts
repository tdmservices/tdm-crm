import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Android wrapper for the TDM CRM web app. The web bundle (dist/) is packaged inside the APK and talks to the
 * API server at VITE_API_URL (set at build time). Sideloaded: no Play Store.
 */
const config: CapacitorConfig = {
  appId: "services.tdm.crm",
  appName: "TDM CRM",
  webDir: "dist",
  android: { allowMixedContent: false },
  server: { androidScheme: "https" },
};
export default config;
