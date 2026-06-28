import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.emmertex.carbon',
  appName: 'Carbon',
  // The web build is the single source of truth — Capacitor copies it into the
  // Android project's assets on `cap sync`. The Carbon sync server is configured
  // in-app (Settings → Sync server), not here.
  webDir: '../web/dist',
  android: {
    // App is served from https://localhost inside the WebView. If your Carbon
    // server is plain http on the LAN you'll hit mixed-content blocks — prefer
    // pointing the app at an https URL (e.g. via Nginx Proxy Manager). Set
    // `allowMixedContent: true` only as a last resort for http-only servers.
    allowMixedContent: false,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
