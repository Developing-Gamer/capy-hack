import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PlayerInfo } from '../../../game/src/shared/protocol';
import { GameView } from '../../game/GameView';

const ALL_LIMBS: PlayerInfo['limbs'] = ['ra', 'la', 'rl', 'll'];
const BOTS: PlayerInfo[] = [
  { id: 'bot-bruno', name: 'Bruno', hat: 'top', limbs: ALL_LIMBS, isBot: true },
  { id: 'bot-maude', name: 'Maude', hat: 'bucket', limbs: ALL_LIMBS, isBot: true },
  { id: 'bot-dex', name: 'Dex', hat: 'cone', limbs: ALL_LIMBS, isBot: true },
];

/** Solo play: one round of a game against bots, no buy-in. Online trials run on /trials. */
export default function PlayScreen() {
  const { game, name } = useLocalSearchParams<{ game: string; name?: string }>();
  const insets = useSafeAreaInsets();
  const [round, setRound] = useState(0);
  const [over, setOver] = useState(false);
  const [seed] = useState(() => Math.floor(Math.random() * 1e9));

  return (
    <View style={styles.screen}>
      <StatusBar hidden />
      <GameView
        key={round}
        start={{
          type: 'start',
          game: game ?? 'dinner',
          seed: seed + round,
          you: 'you',
          pot: 40,
          players: [{ id: 'you', name: name?.trim() || 'You', hat: 'cone', limbs: ALL_LIMBS, isBot: false }, ...BOTS],
        }}
        onMessage={(msg) => {
          if (msg.type === 'result') setOver(true);
        }}
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
  actions: { position: 'absolute', left: 24, right: 24, flexDirection: 'row', gap: 12 },
  btn: { flex: 1, padding: 16, alignItems: 'center', backgroundColor: '#1a1512', borderWidth: 1, borderColor: '#5a4d40', borderRadius: 12 },
  again: { backgroundColor: '#a50f0c', borderColor: '#a50f0c' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 3 },
});
