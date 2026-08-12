/** CDNs a widget may load libraries from. Same allowlist claude.ai uses. */
export const WIDGET_CDNS = [
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://esm.sh',
];

/**
 * Agent-authored code, so the frame is sandboxed without allow-same-origin: an
 * opaque origin, no cookies, no reach into the app. The CSP bounds the rest, so a
 * widget can pull Chart.js but can't phone home.
 */
function csp(): string {
  const cdns = WIDGET_CDNS.join(' ');
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${cdns}`,
    `style-src 'unsafe-inline' ${cdns} https://fonts.googleapis.com`,
    'img-src data: blob: https:',
    'font-src data: https:',
    `connect-src ${cdns}`,
  ].join('; ');
}

const RUNTIME = `
(function () {
  var parent = window.parent;
  var root = document.getElementById('root');
  var last = null;
  var scripted = false;

  function post(msg) { parent.postMessage(msg, '*'); }

  // The only way a widget can talk to Casper: ask for a prompt to be sent. The
  // app decides whether to honour it.
  window.casper = {
    sendPrompt: function (text) {
      if (typeof text !== 'string' || !text.trim()) return;
      post({ type: 'casper:prompt', text: text.slice(0, 4000) });
    },
  };

  // Guarded, because a second pass would replace the nodes a widget's scripts are
  // already driving with inert copies.
  function setContent(html) {
    if (!root) root = document.getElementById('root');
    if (!root || html === last) return;
    last = html;
    root.innerHTML = html;
  }

  // innerHTML leaves scripts inert; recreating them runs them, once the content is
  // final so a half-written script never executes. One at a time, waiting on anything
  // with a src: a real document blocks there, and running them all at once is how you
  // get "Chart is not defined".
  function runScripts() {
    if (scripted) return;
    scripted = true;
    var list = [].slice.call(root.querySelectorAll('script'));
    var index = 0;

    function next() {
      if (index >= list.length) return;
      var old = list[index++];
      var fresh = document.createElement('script');
      for (var a = 0; a < old.attributes.length; a++) {
        fresh.setAttribute(old.attributes[a].name, old.attributes[a].value);
      }
      fresh.textContent = old.textContent;
      var external = Boolean(old.getAttribute('src'));
      if (external) {
        fresh.async = false;
        var moved = false;
        var advance = function () {
          if (moved) return;
          moved = true;
          next();
        };
        fresh.onload = advance;
        fresh.onerror = advance;
        // A CDN that never answers shouldn't strand the rest of the widget.
        setTimeout(advance, 10000);
      }
      old.parentNode.replaceChild(fresh, old);
      if (!external) next();
    }

    next();
  }

  var lastHeight = 0;

  // Measured off #root, not the document: in a frame the html box is the viewport,
  // so it reports the size the host already chose rather than the content's. The
  // two spare pixels absorb fractional layout heights, which otherwise leave a
  // sliver of overflow and a scrollbar.
  function contentHeight() {
    if (!root) root = document.getElementById('root');
    var bottom = 0;
    if (root) {
      var box = root.getBoundingClientRect();
      bottom = box.top + Math.max(root.scrollHeight, box.height);
    }
    var body = document.body ? document.body.scrollHeight : 0;
    return Math.ceil(Math.max(bottom, body)) + 2;
  }

  function reportHeight() {
    var h = contentHeight();
    if (h !== lastHeight) { lastHeight = h; post({ type: 'casper:height', height: h }); }
  }

  if (window.ResizeObserver) {
    var ro = new ResizeObserver(reportHeight);
    ro.observe(document.documentElement);
    // The one that actually grows with the content.
    if (root) ro.observe(root);
  }

  // Canvases and late fonts resize without tripping the observer, so poll too -
  // but only briefly after the content settles. A transcript full of widgets each
  // polling forever would read layout dozens of times a second.
  var poll = null;
  function pollHeight(ms) {
    if (poll) clearInterval(poll);
    var until = Date.now() + ms;
    poll = setInterval(function () {
      reportHeight();
      if (Date.now() > until) { clearInterval(poll); poll = null; }
    }, 250);
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'casper:theme') {
      document.getElementById('theme').textContent = ':root{' + d.css + '}';
      return;
    }
    if (d.type !== 'casper:html') return;
    setContent(d.html);
    reportHeight();
    runScripts();
    // Scripts can draw for a while after they run; watch a little longer.
    pollHeight(4000);
  });
})();
`;

const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
/* The host sizes the frame to fit, so a scrollbar in here is always a measuring
   error rather than something to scroll. */
html { overflow: hidden; }
body {
  font-family: var(--font-body, system-ui, sans-serif);
  font-size: 14px;
  line-height: 1.5;
  color: var(--color-text-primary, #f8f8f2);
  overflow-x: hidden;
}
#root { overflow-x: hidden; }
a { color: var(--color-accent, #bd93f9); }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--color-border, #44475a); border-radius: 4px; }
`;

/** The document every widget runs inside. Static, so the frame is created once. */
export function buildWidgetShell(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp()}">
<meta name="color-scheme" content="dark">
<style>${BASE_CSS}</style>
<style id="theme"></style>
</head>
<body><div id="root"></div>
<!-- Runtime last: it grabs #root on the way in, so the element has to exist. -->
<script>${RUNTIME}</script>
</body>
</html>`;
}
