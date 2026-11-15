import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '../../convex/_generated/api';

export default function LobbyScreen() {
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation(api.rooms.create);
  const join = useMutation(api.rooms.join);
  const data = useQuery(api.rooms.get, code ? { code } : 'skip');

  const run = async (fn: () => Promise<{ code: string }>) => {
    setError(null);
    try {
      setCode((await fn()).code);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (code) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.kicker}>TEST BATCH</Text>
        <Text style={styles.code}>{code}</Text>
        <Text style={styles.pot}>POT ${data?.room.pot ?? 0}</Text>
        <View style={styles.list}>
          {data?.players.map((p) => (
            <View key={p._id} style={styles.row}>
              <Text style={styles.rowName}>{p.name}</Text>
              <Text style={styles.rowMeta}>{p.paid ? 'SIGNED · $10' : 'UNSIGNED'}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.hint}>Friends join with this code. The waiver and $10 buy-in come next.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.logo}>MEAT{'\n'}<Text style={styles.logoRed}>MARKET</Text></Text>
      <TextInput style={styles.input} placeholder="Your name" placeholderTextColor="#6b5f52" value={name} onChangeText={setName} />
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
          value={joinCode}
          onChangeText={setJoinCode}
        />
        <Pressable style={[styles.cta, styles.ghost]} disabled={!name || joinCode.length !== 4} onPress={() => run(() => join({ code: joinCode, name }))}>
          <Text style={styles.ctaText}>JOIN</Text>
        </Pressable>
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b0908', padding: 24, gap: 14, justifyContent: 'center' },
  logo: { color: '#e9dcc3', fontSize: 52, fontWeight: '800', lineHeight: 52, marginBottom: 24 },
  logoRed: { color: '#ff4a3a' },
  input: { borderWidth: 1, borderColor: '#3a322b', borderRadius: 12, padding: 16, color: '#e9dcc3', fontSize: 18 },
  cta: { backgroundColor: '#a50f0c', borderRadius: 12, padding: 18, alignItems: 'center' },
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
});
