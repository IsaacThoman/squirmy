import { plural } from '@squirmy/client-core';
import { useRouter } from 'expo-router';
import { ActivityIndicator } from 'react-native';
import { closeSheet } from '../closeSheet';
import { SheetFacts, SheetFrame, SheetNote, SheetPickerRow, SheetRow, SheetRows } from '../SheetUI';
import { listeningTime, previousLine, rankDetail, replayPeriods, replayTop, replayWindow, streakLine } from './replay';
import { useReplay } from './useReplay';

/** Replay: what the user listened to in a period, as the web's Replay page. */
export function ReplayScreen() {
  const router = useRouter();
  const replay = useReplay();
  const { stats } = replay;
  return <SheetFrame title="Replay" onClose={() => closeSheet(router)}>
    <SheetPickerRow label="Period" value={replay.period} options={replayPeriods} onChange={replay.setPeriod} />
    {stats ? <>
      <SheetFacts title={replayWindow(stats, replay.tz)} rows={[
        { label: 'Time listened', value: listeningTime(stats.totals.msPlayed) },
        { label: 'Plays', value: stats.totals.plays.toLocaleString() },
        { label: 'Songs', value: stats.totals.tracks.toLocaleString() },
        { label: 'Artists', value: stats.totals.artists.toLocaleString() },
        { label: 'Albums', value: stats.totals.albums.toLocaleString() },
      ]} />
      {previousLine(stats) && <SheetNote>{previousLine(stats)!}</SheetNote>}
      {stats.totals.plays === 0 ? <SheetNote>No plays in this period. Choose another period, or import your listening history on the web.</SheetNote> : <>
        <SheetNote>{streakLine(stats)}</SheetNote>
        <SheetRows>
          {stats.tracks.slice(0, replayTop).map(row => <SheetRow key={row.key} title={row.name} subtitle={`${row.artist ?? ''} · ${rankDetail(row)}`}
            icon="music.note" onPress={() => row.track && replay.play(row.track)} />)}
          {stats.artists.slice(0, replayTop).map(row => <SheetRow key={row.key} title={row.name} subtitle={rankDetail(row)}
            icon="music.mic" onPress={() => row.id && replay.open('artist', row.id)} />)}
          {stats.albums.slice(0, replayTop).map(row => <SheetRow key={row.key} title={row.name} subtitle={`${row.artist ?? ''} · ${rankDetail(row)}`}
            icon="square.stack" onPress={() => row.id && replay.open('album', row.id)} />)}
        </SheetRows>
        {stats.genres.length > 0 && <SheetFacts title="Top genres"
          rows={stats.genres.slice(0, replayTop).map(genre => ({ label: genre.name, value: plural(genre.plays, 'play') }))} />}
      </>}
    </> : replay.failure ? <SheetRows>
      <SheetRow title="Couldn’t load Replay" subtitle={replay.failure.description} icon="exclamationmark.circle"
        onPress={replay.failure.retry ?? (() => {})} />
    </SheetRows> : <ActivityIndicator />}
  </SheetFrame>;
}
