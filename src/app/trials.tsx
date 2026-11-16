import { useMutation, useQuery } from 'convex/react';
import { useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { GameToApp, Hat, Limb, OfferId, StartMessage } from '../../game/src/shared/protocol';
import { GameView } from '../game/GameView';

const OFFER_NAMES: Record<OfferId, string> = { short_fuse: 'SHORT FUSE', marked: 'MARKED', one_more_round: 'ONE MORE ROUND', limb_swap: 'LIMB SWAP' };
/** How long a victim sees that sabotage on them was voided. */
const NOTICE_MS = 6000;

/** Offset (ms) to add to Date.now() to get the server clock, from the fastest of a few round trips. */
function useServerOffset() {
  const clock = useMutation(api.trials.clock);
  const [offset, setOffset] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      let best = { rtt: Infinity, offset: 0 };
      for (let i = 0; i < 4; i++) {
        const t0 = Date.now();
        const server = await clock({});
        const t1 = Date.now();
        if (t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: server - (t0 + t1) / 2 };
      }
      if (live) setOffset(best.offset);
    })();
    return () => {
      live = false;
    };
  }, [clock]);
  return offset;
}

/** The online run: follows the room's current trial on every phone; the lobby takes over at the payout. */
export default function TrialsScreen() {
  const { code, me } = useLocalSearchParams<{ code: string; me: string }>();
  const playerId = me as Id<'players'>;
  const insets = useSafeAreaInsets();
  const room = useQuery(api.rooms.get, code ? { code } : 'skip');
  const matchId = room?.room.matchId;
  const match = useQuery(api.trials.watch, matchId ? { matchId } : 'skip');
  const act = useMutation(api.trials.act);
  const offset = useServerOffset();
  const [done, setDone] = useState<string | null>(null);
  const [noticeOff, setNoticeOff] = useState<string | null>(null);

  useEffect(() => {
    if (!match) return;
    const id = match.matchId;
    const timer = setTimeout(() => setNoticeOff(id), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [match?.matchId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = useMemo<StartMessage | null>(() => {
    if (!match || offset === null || !room) return null;
    return {
      type: 'start',
      game: match.game,
      seed: match.seed,
      you: playerId,
      pot: room.room.pot,
      startAt: match.startAt - offset,
      // In a game each phone plays alone, the other humans are played by bots on this phone.
      players: match.seats.map((s) => ({ id: s.id, name: s.name, hat: s.hat as Hat, limbs: s.limbs as Limb[], isBot: s.bot || (!match.shared && s.id !== playerId) })),
      purchases: match.purchases,
    };
    // A new match is the only thing that should restart the WebView.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match?.matchId, offset]);

  const onMessage = (msg: GameToApp) => {
    if (!match) return;
    if (msg.type === 'net') void act({ matchId: match.matchId, playerId, data: msg.data });
    else if (msg.type === 'result') {
      setDone(match.matchId);
      void act({ matchId: match.matchId, playerId, data: { kind: 'result', ...msg } });
    }
  };

  if (!start || !match) return <View style={styles.screen} />;

  const meSeated = match.seats.some((s) => s.id === playerId);
  const mine = match.results?.find((r) => r.id === playerId);
  const meAlive = room?.players.find((p) => p._id === playerId)?.alive !== false;
  const between = mine?.dead ? (meAlive ? 'LIMB RECLAIMED. CONTINUE.' : 'OUT OF LIMBS.') : 'STAND BY.';
  const voided = [...new Set(match.voided.filter((p) => p.victim === playerId).map((p) => OFFER_NAMES[p.offer]))];
  const notice = noticeOff !== match.matchId && voided.length > 0 ? `${voided.join(' · ')} VOIDED.` : null;
  return (
    <View style={styles.screen}>
      <StatusBar hidden />
      <GameView key={match.matchId} start={start} net={match.view} onMessage={onMessage} />
      {(match.over || done === match.matchId) && (
        <View style={[styles.banner, { bottom: insets.bottom + 24 }]}>
          <Text style={styles.bannerText}>{between}</Text>
        </View>
      )}
      {notice && (
        <View style={[styles.banner, { top: insets.top + 8 }]}>
          <Text style={styles.bannerText}>{notice}</Text>
        </View>
      )}
      {!meSeated && (
        <View style={[styles.banner, { top: insets.top + 8 }]}>
          <Text style={styles.bannerText}>SPECTATING</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  banner: { position: 'absolute', left: 24, right: 24, padding: 12, alignItems: 'center', borderRadius: 10, backgroundColor: 'rgba(20,12,10,0.85)', borderWidth: 1, borderColor: '#5a1a14' },
  bannerText: { color: '#e9dcc3', fontSize: 13, fontWeight: '800', letterSpacing: 3 },
});
