import * as Haptics from 'expo-haptics';
import { useQuery } from 'convex/react';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { api } from '../../../convex/_generated/api';
import type { GameToApp, HapticKind, Hat, PlayerInfo, StartMessage } from '../../../game/src/shared/protocol';
import { GAME_HTML } from '../../game/html';

const ALL_LIMBS: PlayerInfo['limbs'] = ['ra', 'la', 'rl', 'll'];
const BOTS: PlayerInfo[] = [
  { id: 'bot-bruno', name: 'Bruno', hat: 'top', limbs: ALL_LIMBS, isBot: true },
  { id: 'bot-maude', name: 'Maude', hat: 'bucket', limbs: ALL_LIMBS, isBot: true },
  { id: 'bot-dex', name: 'Dex', hat: 'cone', limbs: ALL_LIMBS, isBot: true },
];

// react-native-webview's typings default the extra-props generic to `undefined`, which TS 6 collapses to never.
const GameWebView = WebView<object>;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function haptic(kind: HapticKind) {
  if (kind === 'light') return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  if (kind === 'heavy') return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  for (const ms of [90, 140, 220]) {
    await wait(ms);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  }
}

const HAT: Record<string, Hat> = { cone: 'cone', 'top hat': 'top', bucket: 'bucket', none: 'none' };

function seedFrom(text: string) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Embeds the game bundle in a WebView. Solo by default; with a room code, seats the room's players and fills the rest with bots. */
export default function PlayScreen() {
  const { game, name, code, me } = useLocalSearchParams<{ game: string; name?: string; code?: string; me?: string }>();
  const room = useQuery(api.rooms.get, code ? { code } : 'skip');
  const insets = useSafeAreaInsets();
  const ref = useRef<WebView<object>>(null);
  const [round, setRound] = useState(0);
  const [over, setOver] = useState(false);

  const onMessage = (e: WebViewMessageEvent) => {
    let msg: GameToApp;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      const seated: PlayerInfo[] = room
        ? room.players.map((p) => ({ id: p._id, name: p.name, hat: HAT[p.hat] ?? 'none', limbs: ALL_LIMBS, isBot: p._id !== me }))
        : [{ id: 'you', name: name?.trim() || 'You', hat: 'cone', limbs: ALL_LIMBS, isBot: false }];
      const start: StartMessage = {
        type: 'start',
        game: game ?? 'dinner',
        seed: room ? seedFrom(`${room.room.code}:${round}`) : Math.floor(Math.random() * 1e9),
        you: room && me ? me : 'you',
        pot: room ? room.room.pot : 40,
        players: [...seated, ...BOTS].slice(0, 4),
      };
      ref.current?.postMessage(JSON.stringify(start));
    }
    else if (msg.type === 'haptic') void haptic(msg.kind);
    else if (msg.type === 'result') setOver(true);
  };

  if (code && !room) return <View style={styles.screen} />;

  return (
    <View style={styles.screen}>
      <StatusBar hidden />
      <GameWebView
        key={round}
        ref={ref}
        source={{ html: GAME_HTML }}
        originWhitelist={['*']}
        onMessage={onMessage}
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
      {over && (
        <View style={[styles.actions, { bottom: insets.bottom + 24 }]}>
          <Pressable
            style={[styles.btn, styles.again]}
            onPress={() => {
              setOver(false);
              setRound((r) => r + 1);
            }}
          >
            <Text style={styles.btnText}>AGAIN</Text>
          </Pressable>
          <Pressable style={styles.btn} onPress={() => router.back()}>
            <Text style={styles.btnText}>LOBBY</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
  actions: { position: 'absolute', left: 24, right: 24, flexDirection: 'row', gap: 12 },
  btn: { flex: 1, padding: 16, alignItems: 'center', backgroundColor: '#1a1512', borderWidth: 1, borderColor: '#5a4d40', borderRadius: 12 },
  again: { backgroundColor: '#a50f0c', borderColor: '#a50f0c' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 3 },
});
