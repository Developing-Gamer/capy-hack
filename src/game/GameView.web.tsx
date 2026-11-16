import { useEffect, useMemo, useRef } from 'react';

import type { AppToGame, GameToApp } from '../../game/src/shared/protocol';
import type { GameViewProps } from './GameView';
import { GAME_HTML } from './html';

const BRIDGE = '<script>window.ReactNativeWebView={postMessage:function(d){parent.postMessage({__mm:d},"*")}}</script>';

/** Web build: the same bundle in an iframe, with the WebView bridge shimmed over postMessage. */
export function GameView({ start, net, onMessage }: GameViewProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const html = useMemo(() => GAME_HTML.replace('<head>', '<head>' + BRIDGE), []);
  const latest = useRef({ start, net, onMessage });
  useEffect(() => {
    latest.current = { start, net, onMessage };
  });
  const post = (msg: AppToGame) => frame.current?.contentWindow?.postMessage(JSON.stringify(msg), '*');

  useEffect(() => {
    if (ready.current && net !== undefined) post({ type: 'net', data: net });
  }, [net]);

  useEffect(() => {
    const listen = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || typeof e.data?.__mm !== 'string') return;
      const msg: GameToApp = JSON.parse(e.data.__mm);
      const { start, net, onMessage } = latest.current;
      if (msg.type === 'ready') {
        ready.current = true;
        post(start);
        if (net !== undefined) post({ type: 'net', data: net });
      }
      onMessage?.(msg);
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, []);

  return <iframe ref={frame} srcDoc={html} style={{ flex: 1, width: '100%', height: '100%', border: 0, background: '#000' }} allow="autoplay" />;
}
