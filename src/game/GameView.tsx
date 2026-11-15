import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import type { AppToGame, GameToApp, HapticKind, StartMessage } from '../../game/src/shared/protocol';
import { GAME_HTML } from './html';

// react-native-webview's typings default the extra-props generic to `undefined`, which TS 6 collapses to never.
const GameWebView = WebView<object>;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function haptic(kind: HapticKind) {
  if (kind === 'light') return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  if (kind === 'heavy') return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  for (const ms of [90, 140, 220]) {
    await wait(ms);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  }
}

export interface GameViewProps {
  /** Sent once the page reports `ready`. */
  start: StartMessage;
  /** Latest server view for online rounds; posted as a `net` message whenever it changes. */
  net?: unknown;
  onMessage?: (msg: GameToApp) => void;
}

/** The game bundle in a WebView: posts `start`, relays `net`, plays haptics. Remount it (key) for a new round. */
export function GameView({ start, net, onMessage }: GameViewProps) {
  const ref = useRef<WebView<object>>(null);
  const ready = useRef(false);
  const post = (msg: AppToGame) => ref.current?.postMessage(JSON.stringify(msg));

  useEffect(() => {
    if (ready.current && net !== undefined) post({ type: 'net', data: net });
  }, [net]);

  const handle = (e: WebViewMessageEvent) => {
    let msg: GameToApp;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      ready.current = true;
      post(start);
      if (net !== undefined) post({ type: 'net', data: net });
    } else if (msg.type === 'haptic') void haptic(msg.kind);
    onMessage?.(msg);
  };

  return (
    <GameWebView
      ref={ref}
      source={{ html: GAME_HTML }}
      originWhitelist={['*']}
      onMessage={handle}
      style={styles.web}
      containerStyle={styles.web}
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      allowsBackForwardNavigationGestures={false}
      webviewDebuggingEnabled
    />
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: '#000' },
});
