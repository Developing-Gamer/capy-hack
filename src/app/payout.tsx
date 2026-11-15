import * as Haptics from 'expo-haptics';
import { useQuery } from 'convex/react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '../../convex/_generated/api';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
const money = (n: number) => `$${n.toFixed(2)}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Line = { label: string; value: string; tone?: 'red' | 'green' | 'amber' | 'dim' };

/** The end of a batch: the sole survivor watches the pot land in Whop, everyone else gets the bill. */
export default function PayoutScreen() {
  const { code, me } = useLocalSearchParams<{ code: string; me?: string }>();
  const data = useQuery(api.payout.room, code ? { code } : 'skip');
  if (!data?.room.winnerId) return <View style={styles.screen} />;

  const { room, players, payout } = data;
  const winner = players.find((p) => p._id === room.winnerId)!;
  const meP = players.find((p) => p._id === me);
  const won = winner._id === me;
  const paid = players.filter((p) => p.paid).length;
  const status = payout?.status ?? 'sending';
  const STATUS = { sending: 'SENDING…', processing: 'SENDING…', paid: '● SENT', owed: '▲ OWED' } as const;
  const statusTone = status === 'paid' ? 'green' : status === 'owed' ? 'red' : 'amber';

  const lines: Line[] = won
    ? [
        { label: `POT ($${room.buyIn} × ${paid})`, value: money(payout?.amount ?? room.pot), tone: 'green' },
        { label: 'LIMBS', value: `${winner.limbs}/4` },
        { label: 'WHOP', value: STATUS[status], tone: statusTone },
      ]
    : [
        { label: `LIMBS ×${meP?.limbs ?? 4}`, value: 'RECLAIMED', tone: 'red' },
        { label: 'BUY-IN', value: `-${money(room.buyIn)}`, tone: 'red' },
        { label: 'DIGNITY', value: 'NOT FOUND', tone: 'dim' },
      ];

  const assessment = won ? 'Survival noted. Do not expect it twice.' : 'Did not meet survival criteria. Remains processed.';

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <Lamp />
      {won ? <Bills /> : <Blood />}
      <SafeAreaView style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} bounces={false}>
          <Text style={styles.kicker}>BATCH {room.code}</Text>
          {won ? <Winner pot={payout?.amount ?? room.pot} status={status} /> : <Terminated />}

          <Animated.View entering={FadeIn.delay(won ? 1600 : 900)} style={styles.receipt}>
            <View style={styles.receiptHead}>
              <Text style={styles.receiptHeadText}>{won ? 'WHOP · PAYOUT' : 'ASSET RECOVERY'}</Text>
            </View>
            {lines.map((line, i) => (
              <ReceiptLine key={line.label} line={line} delay={(won ? 1700 : 1000) + i * 160} haptic={!won} />
            ))}
            <Animated.Text entering={FadeIn.delay((won ? 1700 : 1000) + lines.length * 160 + 200)} style={styles.assessment}>
              {assessment}
            </Animated.Text>
          </Animated.View>

          <View style={styles.standings}>
            {[winner, ...players.filter((p) => p._id !== winner._id)].map((p, i) => (
              <View key={p._id} style={[styles.stand, i === 0 && styles.standWin, p._id === me && styles.standMe]}>
                <Text style={[styles.standRank, i === 0 && styles.green]}>{i + 1}</Text>
                <Text style={styles.standName}>{p.name.toUpperCase()}{p._id === me ? ' (YOU)' : ''}</Text>
                <Text style={[styles.standMeta, i === 0 ? styles.green : styles.red]}>{i === 0 ? 'SURVIVED' : 'TERMINATED'}</Text>
              </View>
            ))}
          </View>

          <Pressable
            style={styles.cta}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
              router.dismissTo('/');
            }}
          >
            <Text style={styles.ctaText}>NEW BATCH</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function Winner({ pot, status }: { pot: number; status: string }) {
  const [shown, setShown] = useState(0);
  const pulse = useSharedValue(1);
  const paidOnce = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await wait(400);
      const steps = Math.max(1, Math.round(pot));
      for (let i = 1; i <= steps && !cancelled; i++) {
        setShown((pot * i) / steps);
        void Haptics.selectionAsync();
        await wait(1100 / steps);
      }
      if (cancelled) return;
      pulse.value = withSequence(withTiming(1.18, { duration: 120 }), withTiming(1, { duration: 260 }));
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    })();
    return () => {
      cancelled = true;
    };
  }, [pot, pulse]);

  useEffect(() => {
    if (status !== 'paid' || paidOnce.current) return;
    paidOnce.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [status]);

  const amt = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));
  const into = status === 'paid' ? 'PAID TO YOUR WHOP' : status === 'owed' ? 'OWED BY THE HOUSE' : 'SENDING TO YOUR WHOP…';

  return (
    <View style={styles.hero}>
      <Text style={styles.sole}>SOLE{'\n'}SURVIVOR</Text>
      <Animated.Text style={[styles.amount, amt]}>+{money(shown)}</Animated.Text>
      <Animated.Text entering={FadeIn.delay(1500)} style={[styles.into, status === 'owed' && styles.red]}>
        {into}
      </Animated.Text>
    </View>
  );
}

function Terminated() {
  const shake = useSharedValue(0);
  const flash = useSharedValue(1);

  useEffect(() => {
    shake.value = withSequence(...[14, -12, 9, -7, 4, -2, 0].map((x) => withTiming(x, { duration: 50 })));
    flash.value = withTiming(0, { duration: 700 });
    (async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      for (const ms of [90, 140, 220]) {
        await wait(ms);
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      }
    })();
  }, [shake, flash]);

  const title = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));
  const flashStyle = useAnimatedStyle(() => ({ opacity: flash.value }));

  return (
    <View style={styles.hero}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.flash, flashStyle]} />
      <Animated.Text style={[styles.terminated, title]}>TERMINATED</Animated.Text>
    </View>
  );
}

function ReceiptLine({ line, delay, haptic }: { line: Line; delay: number; haptic: boolean }) {
  useEffect(() => {
    if (!haptic) return;
    const t = setTimeout(() => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium), delay);
    return () => clearTimeout(t);
  }, [haptic, delay]);
  const tone = line.tone ? styles[line.tone] : undefined;
  return (
    <Animated.View entering={FadeInDown.delay(delay).duration(220)} style={styles.row}>
      <Text style={styles.rowLabel}>{line.label}</Text>
      <View style={styles.dots} />
      <Text style={[styles.rowValue, tone]}>{line.value}</Text>
    </Animated.View>
  );
}

function Lamp() {
  const o = useSharedValue(0.9);
  useEffect(() => {
    o.value = withRepeat(
      withSequence(
        withTiming(0.9, { duration: 1800 }),
        withTiming(0.25, { duration: 40 }),
        withTiming(0.85, { duration: 60 }),
        withTiming(0.4, { duration: 50 }),
        withTiming(0.9, { duration: 90 }),
      ),
      -1,
    );
  }, [o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <Animated.View pointerEvents="none" style={[styles.lamp, style]}>
      <View style={styles.lampCore} />
    </Animated.View>
  );
}

function Bills() {
  const { width, height } = useWindowDimensions();
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {Array.from({ length: 22 }, (_, i) => (
        <Bill key={i} i={i} width={width} height={height} />
      ))}
    </View>
  );
}

const rand = (i: number, n: number) => (Math.sin(i * 97.13 + n * 13.7) + 1) / 2;

function Bill({ i, width, height }: { i: number; width: number; height: number }) {
  const seed = (n: number) => rand(i, n);
  const y = useSharedValue(-60);
  useEffect(() => {
    y.value = withDelay(
      rand(i, 1) * 2400,
      withRepeat(withTiming(height + 60, { duration: 2600 + rand(i, 2) * 2600, easing: Easing.linear }), -1),
    );
  }, [y, height, i]);
  const x = seed(3) * width;
  const spin = 200 + seed(4) * 500;
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: x + Math.sin(y.value / 60) * 18 },
      { translateY: y.value },
      { rotate: `${(y.value / spin) * 360}deg` },
      { rotateY: `${(y.value / (spin * 0.6)) * 180}deg` },
    ],
  }));
  return (
    <Animated.View style={[styles.bill, style]}>
      <Text style={styles.billText}>$</Text>
    </Animated.View>
  );
}

function Blood() {
  const { width } = useWindowDimensions();
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {Array.from({ length: 9 }, (_, i) => (
        <Drip key={i} i={i} width={width} />
      ))}
    </View>
  );
}

function Drip({ i, width }: { i: number; width: number }) {
  const seed = (n: number) => rand(i + 50, n);
  const h = useSharedValue(0);
  useEffect(() => {
    h.value = withDelay(rand(i + 50, 1) * 900, withTiming(80 + rand(i + 50, 2) * 320, { duration: 2400 + rand(i + 50, 3) * 3000, easing: Easing.out(Easing.quad) }));
  }, [h, i]);
  const w = 4 + seed(4) * 12;
  const style = useAnimatedStyle(() => ({ height: h.value }));
  return (
    <Animated.View style={[styles.drip, { left: seed(5) * (width - w), width: w, borderBottomLeftRadius: w, borderBottomRightRadius: w }, style]} />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#060504' },
  flex: { flex: 1 },
  content: { padding: 22, gap: 18, paddingBottom: 40 },
  kicker: { color: '#8d8170', fontFamily: MONO, fontSize: 12, letterSpacing: 3, textAlign: 'center', marginTop: 8 },
  hero: { alignItems: 'center', gap: 6, paddingVertical: 12 },
  sole: { color: '#e9dcc3', fontSize: 46, fontWeight: '900', lineHeight: 46, letterSpacing: 3, textAlign: 'center' },
  amount: { color: '#9fe07a', fontSize: 64, fontWeight: '900', fontVariant: ['tabular-nums'], textShadowColor: '#3f7a22', textShadowRadius: 18 },
  into: { color: '#a3967f', fontFamily: MONO, fontSize: 11, letterSpacing: 2, textAlign: 'center' },
  terminated: { color: '#ff2a1a', fontSize: 52, fontWeight: '900', letterSpacing: 2, textShadowColor: '#7a0000', textShadowRadius: 20 },
  flash: { backgroundColor: '#b00000' },
  receipt: { backgroundColor: '#e8e0cf', borderRadius: 4, padding: 16, gap: 7, transform: [{ rotate: '-1deg' }] },
  receiptHead: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 1, borderStyle: 'dashed', borderColor: '#5a5246', paddingBottom: 8, marginBottom: 4 },
  receiptHeadText: { color: '#1a1512', fontFamily: MONO, fontSize: 12, fontWeight: '700', letterSpacing: 2 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  rowLabel: { color: '#2a241f', fontFamily: MONO, fontSize: 13 },
  dots: { flex: 1, borderBottomWidth: 1, borderStyle: 'dotted', borderColor: '#8d8170', marginBottom: 4 },
  rowValue: { color: '#1a1512', fontFamily: MONO, fontSize: 13, fontWeight: '700' },
  assessment: { color: '#3a322b', fontFamily: MONO, fontSize: 11, lineHeight: 16, marginTop: 8, borderTopWidth: 1, borderStyle: 'dashed', borderColor: '#5a5246', paddingTop: 8 },
  red: { color: '#c0180c' },
  green: { color: '#3f8a22' },
  amber: { color: '#b07800' },
  dim: { color: '#6b5f52' },
  standings: { gap: 6 },
  stand: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#2a241f', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: '#0e0b09' },
  standWin: { borderColor: '#3f7a22' },
  standMe: { backgroundColor: '#1a1210' },
  standRank: { color: '#6b5f52', fontFamily: MONO, fontSize: 16, fontWeight: '800', width: 16 },
  standName: { flex: 1, color: '#e9dcc3', fontSize: 15, fontWeight: '700', letterSpacing: 1 },
  standMeta: { fontFamily: MONO, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  cta: { backgroundColor: '#a50f0c', borderRadius: 12, padding: 18, alignItems: 'center', marginTop: 4 },
  ctaText: { color: '#fff', fontSize: 20, fontWeight: '900', letterSpacing: 4 },
  lamp: { position: 'absolute', top: -140, alignSelf: 'center', width: 420, height: 320, borderRadius: 210, backgroundColor: 'rgba(255,190,110,0.07)', alignItems: 'center', justifyContent: 'flex-end' },
  lampCore: { width: 200, height: 120, borderRadius: 100, backgroundColor: 'rgba(255,200,130,0.08)', marginBottom: 40 },
  bill: { position: 'absolute', top: 0, left: 0, width: 46, height: 22, borderRadius: 2, backgroundColor: '#6f9a52', borderWidth: 1, borderColor: '#4a6e34', alignItems: 'center', justifyContent: 'center', opacity: 0.85 },
  billText: { color: '#2e4a1f', fontWeight: '900', fontSize: 13 },
  drip: { position: 'absolute', top: 0, backgroundColor: '#7a0806' },
});
