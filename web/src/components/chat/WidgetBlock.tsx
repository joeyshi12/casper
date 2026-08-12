import { useEffect, useRef, useState } from 'react';
import { buildWidgetShell } from './widgetShell.js';
import { sendWidgetPrompt } from '../../state/promptBridge.js';

// Built once: React reloads the frame when srcDoc changes.
const SHELL = buildWidgetShell();

const MAX_WIDGET_CHARS = 256 * 1024;

/** Theme values a widget can use, so it matches the app without knowing about it. */
function themeCss(): string {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return [
    `--color-background-primary:${v('--n0')}`,
    `--color-background-secondary:${v('--n1')}`,
    `--color-border:${v('--n2')}`,
    `--color-text-secondary:${v('--n4')}`,
    `--color-text-primary:${v('--n5')}`,
    `--color-accent:${v('--frost')}`,
    `--color-accent-alt:${v('--aurora-purple')}`,
    `--color-teal:${v('--frost-teal')}`,
    `--color-green:${v('--aurora-green')}`,
    `--color-yellow:${v('--aurora-yellow')}`,
    `--color-orange:${v('--aurora-orange')}`,
    `--color-red:${v('--aurora-red')}`,
    `--font-body:${v('--font-body')}`,
    `--font-mono:${v('--font-mono')}`,
  ].join(';');
}

/**
 * An agent-written widget, rendered inline. Content is patched in as it streams so
 * existing nodes survive, and scripts run once the message is whole.
 */
export function WidgetBlock({ code }: { code: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(120);
  const tooBig = code.length > MAX_WIDGET_CHARS;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onMessage = (e: MessageEvent) => {
      // Opaque origin, so origin can't identify the sender - the window can.
      if (e.source !== frame.contentWindow) return;
      const d = e.data as { type?: string; height?: number; text?: string };
      if (d?.type === 'casper:height' && typeof d.height === 'number') {
        setHeight(Math.min(Math.max(d.height, 40), 2000));
      } else if (d?.type === 'casper:prompt' && typeof d.text === 'string') {
        sendWidgetPrompt(d.text);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!ready) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: 'casper:theme', css: themeCss() },
      '*',
    );
  }, [ready]);

  useEffect(() => {
    if (!ready || tooBig) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: 'casper:html', html: code.trimStart() },
      '*',
    );
  }, [code, ready, tooBig]);

  // The runtime sits at the end of the frame's body, so load means it is listening.
  const onLoad = () => setReady(true);

  if (tooBig) {
    return (
      <div className="widget-error">
        Widget is {Math.round(code.length / 1024)} KB, too large to render.
      </div>
    );
  }

  return (
    <div className="widget-wrap" style={{ height }}>
      <iframe
        ref={frameRef}
        className="widget-frame"
        title="Widget"
        sandbox="allow-scripts"
        srcDoc={SHELL}
        onLoad={onLoad}
      />
    </div>
  );
}
