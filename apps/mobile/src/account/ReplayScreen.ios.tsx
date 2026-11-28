import { Button, Form, Host, HStack, LabeledContent, ProgressView, Section, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityLabel, font, foregroundStyle, frame, lineLimit, monospacedDigit, scrollContentBackground, tint,
} from '@expo/ui/swift-ui/modifiers';
import { plural } from '@squirmy/client-core';
import type { Artwork, ReplayStats } from '@squirmy/contracts';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';
import { closeSheet } from '../closeSheet';
import { hitShape, NativeCover, plainButton } from '../native/Controls';
import { SheetFormHeader, SheetPickerRow } from '../SheetUI';
import { useColors } from '../theme';
import { listeningTime, previousLine, rankDetail, replayPeriods, replayTop, replayWindow, streakLine } from './replay';
import { useReplay } from './useReplay';

/** Replay: what the user listened to in a period, as the web's Replay page, in the sheet's form style. */
export function ReplayScreen() {
  const colors = useColors();
  const router = useRouter();
  const replay = useReplay();
  const { stats } = replay;
  const muted = foregroundStyle(colors.muted);
  return <Host style={styles.page}>
    <VStack spacing={0}>
      <SheetFormHeader title="Replay" onClose={() => closeSheet(router)} />
      <Form modifiers={[scrollContentBackground('hidden'), tint(colors.accent)]}>
        <Section>
          <SheetPickerRow label="Period" value={replay.period} options={replayPeriods} onChange={replay.setPeriod} />
        </Section>
        {stats ? <>
          <Section title={replayWindow(stats, replay.tz)} footer={previousLine(stats) ? <Text>{previousLine(stats)!}</Text> : undefined}>
            <LabeledContent label="Time listened"><Text modifiers={[muted, monospacedDigit()]}>{listeningTime(stats.totals.msPlayed)}</Text></LabeledContent>
            <LabeledContent label="Plays"><Text modifiers={[muted, monospacedDigit()]}>{stats.totals.plays.toLocaleString()}</Text></LabeledContent>
            <LabeledContent label="Songs"><Text modifiers={[muted, monospacedDigit()]}>{stats.totals.tracks.toLocaleString()}</Text></LabeledContent>
            <LabeledContent label="Artists"><Text modifiers={[muted, monospacedDigit()]}>{stats.totals.artists.toLocaleString()}</Text></LabeledContent>
            <LabeledContent label="Albums"><Text modifiers={[muted, monospacedDigit()]}>{stats.totals.albums.toLocaleString()}</Text></LabeledContent>
          </Section>
          {stats.totals.plays === 0 ? <Section>
            <Text modifiers={[muted]}>No plays in this period. Choose another period, or import your listening history on the web.</Text>
          </Section> : <>
            <Section title="Streak"><Text>{streakLine(stats)}</Text></Section>
            <Ranks title="Top Songs" rows={stats.tracks.slice(0, replayTop)}
              artwork={row => row.track?.album?.artwork} onPress={row => row.track && replay.play(row.track)} verb="Play" />
            <Ranks title="Top Artists" rows={stats.artists.slice(0, replayTop)} round
              artwork={row => row.image} onPress={row => row.id && replay.open('artist', row.id)} verb="Open" />
            <Ranks title="Top Albums" rows={stats.albums.slice(0, replayTop)}
              artwork={row => row.album?.artwork} onPress={row => row.id && replay.open('album', row.id)} verb="Open" />
            {stats.genres.length > 0 && <Section title="Top Genres">
              {stats.genres.slice(0, replayTop).map(genre => <LabeledContent key={genre.key} label={genre.name}>
                <Text modifiers={[muted, monospacedDigit()]}>{plural(genre.plays, 'play')}</Text>
              </LabeledContent>)}
            </Section>}
            <Section title="New Discoveries" footer={<Text>{stats.discoveries.count
              ? `${plural(stats.discoveries.count, 'artist')} heard for the first time` : 'No first-time artists in this period.'}</Text>}>
              {stats.discoveries.artists.slice(0, replayTop).map(artist => <Button key={artist.key} label={artist.name}
                onPress={artist.id ? () => replay.open('artist', artist.id!) : undefined} />)}
            </Section>
          </>}
        </> : replay.failure ? <Section>
          <HStack>
            <VStack alignment="leading" spacing={2}>
              <Text>Couldn’t load Replay</Text>
              <Text modifiers={[font({ textStyle: 'footnote' }), muted]}>{replay.failure.description}</Text>
            </VStack>
            <Spacer />
            {replay.failure.retry && <Button label="Try Again" onPress={replay.failure.retry} />}
          </HStack>
        </Section> : <Section><HStack><Spacer /><ProgressView /><Spacer /></HStack></Section>}
      </Form>
    </VStack>
  </Host>;
}

type Rank = ReplayStats['tracks'][number] | ReplayStats['artists'][number] | ReplayStats['albums'][number];

/** A top list: cover, name, who it is by, and how much it was played. A row plays its song or opens its page. */
function Ranks<T extends Rank>({ title, rows, artwork, onPress, verb, round }: {
  title: string; rows: T[]; artwork: (row: T) => Artwork | null | undefined; onPress: (row: T) => void; verb: string; round?: boolean;
}) {
  const colors = useColors();
  if (!rows.length) return null;
  return <Section title={title}>
    {rows.map((row, index) => <Button key={row.key} onPress={() => onPress(row)}
      modifiers={[plainButton, accessibilityLabel(`${index + 1}. ${verb} ${row.name}${row.artist ? ` by ${row.artist}` : ''}, ${rankDetail(row)}`)]}>
      <HStack spacing={12} modifiers={[hitShape]}>
        <Text modifiers={[foregroundStyle(colors.muted), monospacedDigit(), frame({ minWidth: 16 })]}>{String(index + 1)}</Text>
        <NativeCover artwork={artwork(row)} size={44} radius={round ? 22 : 8} />
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ textStyle: 'body', weight: 'medium' }), lineLimit(1)]}>{row.name}</Text>
          <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.muted), lineLimit(1)]}>
            {row.artist ? `${row.artist} · ${rankDetail(row)}` : rankDetail(row)}
          </Text>
        </VStack>
        <Spacer minLength={4} />
      </HStack>
    </Button>)}
  </Section>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
});
