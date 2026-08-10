import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const SERVER_TARGET = process.env.CASPER_SERVER ?? 'http://127.0.0.1:4319';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Casper',
        short_name: 'Casper',
        description: 'Web client for kiro-cli over ACP',
        theme_color: '#282a36',
        background_color: '#282a36',
        display: 'standalone',
        icons: [{ src: '/casper.png', sizes: '32x32', type: 'image/png' }],
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
