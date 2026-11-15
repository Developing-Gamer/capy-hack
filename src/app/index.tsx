import { useAction, useMutation, useQuery } from 'convex/react';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, TextInput, TouchableWithoutFeedback, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';

export default function LobbyScreen() {
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [playerId, setPlayerId] = useState<Id<'players'> | null>(null);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation(api.rooms.create);
  const join = useMutation(api.rooms.join);
  const startTrials = useMutation(api.rooms.start);
  const startBuyIn = useAction(api.buyin.start);
  const confirmBuyIn = useAction(api.buyin.confirm);
  const data = useQuery(api.rooms.get, code ? { code } : 'skip');
  const players = data?.players ?? [];
  const me = players.find((p) => p._id === playerId);
  const host = players[0];
  const isHost = !!host && host._id === playerId;
  const unsigned = players.filter((p) => !p.paid).length;
  const canStart = players.length >= 2 && unsigned === 0;

  const playing = data?.room.status === 'playing';
  const launched = useRef<string | null>(null);
  const landed = useRef<string | null>(null);
  const enterTrial = () => {
    if (!code || !playerId) return;
    router.push({ pathname: '/trials', params: { code, me: playerId } });
  };
  useEffect(() => {
    if (!playing || launched.current === code || !code || !playerId) return;
    launched.current = code;
    router.push({ pathname: '/trials', params: { code, me: playerId } });
  }, [playing, code, playerId]);

  const done = data?.room.status === 'done';
  useEffect(() => {
    if (!done || landed.current === code || !code || !playerId) return;
    landed.current = code;
    if (router.canDismiss()) router.dismissAll();
    router.push({ pathname: '/payout', params: { code, me: playerId } });
  }, [done, code, playerId]);

  const run = async (fn: () => Promise<{ code: string; playerId: Id<'players'> }>) => {
    setError(null);
    try {
      const room = await fn();
      setCode(room.code);
      setPlayerId(room.playerId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const signWaiver = async () => {
    if (!playerId) return;
    setError(null);
    setPaying(true);
    try {
      const returnTo = Linking.createURL('/');
      const url = await startBuyIn({ playerId, returnTo });
      if (url) {
        await WebBrowser.openAuthSessionAsync(url, returnTo, { preferEphemeralSession: true });
        await confirmBuyIn({ playerId });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPaying(false);
    }
  };

  const start = async () => {
    if (!code || !playerId) return;
    setError(null);
    try {
      await startTrials({ code, playerId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (code && data?.room.status === 'playing') {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.kicker}>TEST BATCH {code}</Text>
        <Text style={styles.begun}>THE TRIALS{'\n'}HAVE BEGUN</Text>
        <Text style={styles.pot}>POT ${data.room.pot}</Text>
        <View style={styles.list}>
          {players.map((p) => (
            <View key={p._id} style={styles.row}>
              <Text style={styles.rowName}>{p.name}</Text>
              <Text style={styles.rowMeta}>{p.limbs} LIMBS</Text>
            </View>
          ))}
        </View>
        <Pressable style={styles.cta} onPress={enterTrial}>
          <Text style={styles.ctaText}>ENTER</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const status = !me?.paid
    ? 'SHARE THE CODE.'
    : players.length < 2
      ? 'NEED ONE MORE SUBJECT.'
      : unsigned > 0
        ? `WAITING ON ${unsigned} SIGNATURE${unsigned > 1 ? 'S' : ''}.`
        : isHost
          ? 'ALL SIGNED.'
          : `WAITING FOR ${host?.name.toUpperCase()}.`;

  if (code && !done) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.kicker}>TEST BATCH</Text>
        <Text style={styles.code}>{code}</Text>
        <Text style={styles.pot}>POT ${data?.room.pot ?? 0}</Text>
        <View style={styles.list}>
          {data?.players.map((p) => (
            <View key={p._id} style={styles.row}>
              <Text style={styles.rowName}>{p.name}</Text>
              <Text style={styles.rowMeta}>{p.paid ? 'SIGNED' : 'UNSIGNED'}</Text>
            </View>
          ))}
        </View>
        {me && !me.paid && (
          <View style={styles.waiver}>
            <Text style={styles.waiverTitle}>THE WAIVER</Text>
            <Text style={styles.waiverText}>
              Surrender your limbs and ${data?.room.buyIn}. Last one standing takes the pot.
            </Text>
            <Pressable style={styles.cta} disabled={paying} onPress={signWaiver}>
              {paying ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaText}>SIGN IN BLOOD · ${data?.room.buyIn}</Text>}
            </Pressable>
          </View>
        )}
        {isHost && me?.paid && (
          <Pressable style={[styles.cta, !canStart && styles.disabled]} disabled={!canStart} onPress={start}>
            <Text style={styles.ctaText}>START THE TRIALS</Text>
          </Pressable>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        <Text style={styles.hint}>{status}</Text>
      </SafeAreaView>
    );
  }

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <SafeAreaView style={styles.screen}>
        <Text style={styles.logo}>MEAT{'\n'}<Text style={styles.logoRed}>MARKET</Text></Text>
        <TextInput style={styles.input} placeholder="NAME" placeholderTextColor="#6b5f52" value={name} onChangeText={setName} returnKeyType="done" />
        <Pressable style={styles.cta} disabled={!name} onPress={() => run(() => create({ name }))}>
          <Text style={styles.ctaText}>START A BATCH</Text>
        </Pressable>
        <View style={styles.joinRow}>
          <TextInput
            style={[styles.input, styles.joinInput]}
            placeholder="CODE"
            placeholderTextColor="#6b5f52"
            autoCapitalize="characters"
            maxLength={4}
            returnKeyType="done"
            value={joinCode}
            onChangeText={setJoinCode}
          />
          <Pressable style={[styles.cta, styles.ghost]} disabled={!name || joinCode.length !== 4} onPress={() => run(() => join({ code: joinCode, name }))}>
            <Text style={styles.ctaText}>JOIN</Text>
          </Pressable>
        </View>
        {error && <Text style={styles.error}>{error}</Text>}
        <Pressable style={[styles.cta, styles.solo]} onPress={() => router.push({ pathname: '/play/[game]', params: { game: 'dinner', name } })}>
          <Text style={styles.ctaText}>PRACTICE</Text>
          <Text style={styles.soloSub}>NO BUY-IN</Text>
        </Pressable>
        <Pressable style={[styles.cta, styles.soloNext]} onPress={() => router.push({ pathname: '/play/[game]', params: { game: 'grinder', name } })}>
          <Text style={styles.ctaText}>THE GRINDER</Text>
          <Text style={styles.soloSub}>NO BUY-IN</Text>
        </Pressable>
      </SafeAreaView>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b0908', padding: 24, gap: 14, justifyContent: 'center' },
  logo: { color: '#e9dcc3', fontSize: 52, fontWeight: '800', lineHeight: 52, marginBottom: 24 },
  logoRed: { color: '#ff4a3a' },
  input: { borderWidth: 1, borderColor: '#3a322b', borderRadius: 12, padding: 16, color: '#e9dcc3', fontSize: 18 },
  cta: { backgroundColor: '#a50f0c', borderRadius: 12, padding: 18, alignItems: 'center' },
  solo: { marginTop: 18, backgroundColor: '#140c0a', borderWidth: 1, borderColor: '#a50f0c' },
  soloNext: { backgroundColor: '#140c0a', borderWidth: 1, borderColor: '#a50f0c' },
  soloSub: { color: '#a3967f', fontSize: 11, letterSpacing: 2, marginTop: 4 },
  ghost: { backgroundColor: '#1a1512', borderWidth: 1, borderColor: '#5a4d40', paddingHorizontal: 28 },
  ctaText: { color: '#fff', fontSize: 18, fontWeight: '800', letterSpacing: 2 },
  joinRow: { flexDirection: 'row', gap: 10 },
  joinInput: { flex: 1, letterSpacing: 6, textAlign: 'center' },
  error: { color: '#ff7a6a' },
  kicker: { color: '#a3967f', letterSpacing: 4, textAlign: 'center' },
  code: { color: '#e9dcc3', fontSize: 72, fontWeight: '800', letterSpacing: 12, textAlign: 'center' },
  pot: { color: '#9fe07a', fontSize: 28, fontWeight: '800', textAlign: 'center' },
  list: { gap: 8, marginTop: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', borderWidth: 1, borderColor: '#2a241f', borderRadius: 10, padding: 14 },
  rowName: { color: '#e9dcc3', fontSize: 18, fontWeight: '700' },
  rowMeta: { color: '#f2a900', fontSize: 13, letterSpacing: 1 },
  hint: { color: '#8d8170', textAlign: 'center', marginTop: 12 },
  disabled: { opacity: 0.4 },
  begun: { color: '#ff4a3a', fontSize: 40, fontWeight: '800', lineHeight: 44, textAlign: 'center', letterSpacing: 2 },
  waiver: { gap: 10, marginTop: 16, borderWidth: 1, borderColor: '#5a1a14', borderRadius: 12, padding: 16, backgroundColor: '#140c0a' },
  waiverTitle: { color: '#ff4a3a', fontSize: 14, fontWeight: '800', letterSpacing: 4 },
  waiverText: { color: '#c9bba3', fontSize: 15, lineHeight: 21 },
});
