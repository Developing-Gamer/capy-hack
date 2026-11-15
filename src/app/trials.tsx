import { useMutation, useQuery } from 'convex/react';
import { useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { GameToApp, Hat, Limb, StartMessage } from '../../game/src/shared/protocol';
import { GameView } from '../game/GameView';

const TRIAL_NAMES: Record<string, string> = {
  dinner: 'DINNER PARTY',
  machine: 'THE MACHINE',
  grinder: 'THE GRINDER',
  chamber: 'LAST CHAMBER',
  payout: 'PAYOUT',
};

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

  const start = useMemo<StartMessage | null>(() => {
    if (!match || offset === null || !room) return null;
    return {
      type: 'start',
      game: match.game,
      seed: match.seed,
      you: playerId,
      pot: room.room.pot,
      startAt: match.startAt - offset,
      players: match.seats.map((s) => ({ id: s.id, name: s.name, hat: s.hat as Hat, limbs: s.limbs as Limb[], isBot: s.bot })),
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
  return (
    <View style={styles.screen}>
      <StatusBar hidden />
      <GameView key={match.matchId} start={start} net={match.view} onMessage={onMessage} />
      {(match.over || done === match.matchId) && (
        <View style={[styles.banner, { bottom: insets.bottom + 24 }]}>
          <Text style={styles.bannerText}>NEXT TRIAL LOADING…</Text>
        </View>
      )}
      {!meSeated && (
        <View style={[styles.banner, { top: insets.top + 8 }]}>
          <Text style={styles.bannerText}>SPECTATING · {TRIAL_NAMES[match.game] ?? match.game.toUpperCase()}</Text>
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
