import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const SERVER_TARGET = process.env.CASPER_SERVER ?? 'http://127.0.0.1:4319';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Not the plugin's default .webmanifest: the server's MIME table already covers .json.
      manifestFilename: 'manifest.json',
      manifest: {
        name: 'Casper',
        short_name: 'Casper',
        description: 'Web client for kiro-cli over ACP',
        theme_color: '#282a36',
        background_color: '#282a36',
        // Defaults to "browser", which installs a shortcut with the full browser UI.
        display: 'standalone',
        start_url: '/',
        // Must cover every route, or Android shows a URL bar mid-session.
        scope: '/',
        orientation: 'any',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Android crops to the launcher shape, so the mark sits in a square of
          // 410/sqrt(2) - inside the safe circle, whose corners a 410px square would lose.
          {
            src: '/icons/maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Take control immediately and drop old precaches so a rebuilt app
        // doesn't serve a stale shell that points at now-404'd asset hashes.
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
        // The SPA fallback is for client-side routes only, never for real
        // files (hashed JS/CSS live under /assets) or the API/WS endpoints.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/assets\//, /^\/api\//, /^\/ws/, /\.[a-zA-Z0-9]+$/],
      },
    }),
  ],
  worker: {
    // The worker imports shiki and its grammars dynamically, and the default iife
    // format can't code-split.
    format: 'es',
  },
  build: {
    chunkSizeWarningLimit: 1600, // mermaid + shiki are lazy-loaded, not in the initial bundle
  },
  server: {
    host: true, // bind 0.0.0.0 so other devices on the LAN can reach the dev server
    port: 5173,
    proxy: {
      '/api': { target: SERVER_TARGET, changeOrigin: true },
      '/ws': { target: SERVER_TARGET, ws: true, changeOrigin: true },
    },
  },
});
