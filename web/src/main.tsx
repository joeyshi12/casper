import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/theme.css';
import './styles/app.css';

// PWA update handling. The service worker uses skipWaiting + clientsClaim, so a
// new deploy activates and takes control of open tabs. Without this, the tab
// keeps running the previously cached bundle until the user manually reloads
// (twice), so shipped fixes appear "not deployed". When a NEW worker takes
// control of a page that already had one (a returning visitor getting an
// update), reload once to swap in the fresh assets. Guarded so the first-ever
// install (no prior controller) and repeat reloads don't loop.
if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    window.location.reload();
  });
  // Proactively check for a new service worker on load and whenever the tab
  // regains focus. Combined with the worker's skipWaiting + clientsClaim, this
  // makes a fresh deploy activate and reload without a manual hard refresh.
  navigator.serviceWorker.ready
    .then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
