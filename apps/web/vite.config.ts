import { execSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json';

// Prefer an explicitly injected hash (Docker passes GIT_HASH as a build arg,
// since .git is excluded from the build context). Otherwise read it from git.
let gitHash = process.env.GIT_HASH?.trim() || 'unknown';
if (gitHash === 'unknown') {
  try {
    gitHash = execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    // not a git checkout (e.g. release tarball) — leave as 'unknown'
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_HASH__: JSON.stringify(gitHash),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // CARBON_NO_PWA=1 builds without the service worker (useful for automated
      // screenshotting, which otherwise never reaches network-idle).
      disable: !!process.env.CARBON_NO_PWA,
      // Custom SW (src/sw.ts) adds push + notification handling on top of precaching.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['sql-wasm.wasm', 'favicon.png', 'apple-touch-icon.png'],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,wasm,svg,png,ico}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      manifest: {
        name: 'Carbon',
        short_name: 'Carbon',
        description: 'A simple-on-the-surface, powerful-underneath task manager.',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          // Padded so Android's circular mask can't clip the logo.
          {
            src: '/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 3042,
    host: true,
  },
});
