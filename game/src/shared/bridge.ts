import type { AppToGame, GameToApp } from './protocol';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(data: string): void };
  }
}

export const inApp = () => !!window.ReactNativeWebView;

export function send(msg: GameToApp) {
  const data = JSON.stringify(msg);
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(data);
  else console.log('[bridge]', data);
}

export function onAppMessage(fn: (msg: AppToGame) => void) {
  const handler = (e: Event) => {
    const raw = (e as MessageEvent).data;
    let msg: AppToGame | undefined;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (msg && typeof msg === 'object' && 'type' in msg) fn(msg);
  };
  window.addEventListener('message', handler);
  document.addEventListener('message', handler);
}
