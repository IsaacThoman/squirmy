import type { AlbumDetail, AlbumVersion, TrackVersion, VersionQuality } from '@squirmy/contracts'
import { plural } from './format.js'
import { audioQualityLabel, codecLabel, formatBitrate, formatSampleRate } from './signal.js'

/**
 * Labels for the versions of an album or a song the server holds (an edition in one quality
 * tier, `AlbumVersion`), worded alike on every client: the Versions control of an album page
 * and the versions in Track info.
 */

/** Whether the album page shows a Versions control: the server holds two versions or more. */
export function hasVersions(album: Pick<AlbumDetail, 'ownedVersions'>): boolean {
  return (album.ownedVersions?.length ?? 0) > 1
}

type Edition = Pick<AlbumVersion, 'disambiguation' | 'releaseDate' | 'format' | 'country' | 'label' | 'catalogNumber' | 'identified'>

const capitalized = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1)

/**
 * What tells the edition apart, in a few words: MusicBrainz's note ("2011 remaster"), else
 * its year and media ("1973 · 12″ Vinyl"). A copy no one matched to an edition is
 * "Unidentified edition".
 */
export function versionTitle(version: Edition): string {
  if (!version.identified) return 'Unidentified edition'
  if (version.disambiguation) return capitalized(version.disambiguation)
  const year = version.releaseDate?.slice(0, 4)
  return [year, version.format].filter(Boolean).join(' · ') || 'Edition'
}

/** The label, catalogue number and country, for the line under the title; null when none is known. */
export function versionDetail(version: Edition): string | null {
  if (!version.identified) return null
  const parts = [
    version.disambiguation ? [version.releaseDate?.slice(0, 4), version.format].filter(Boolean).join(' ') : null,
    version.label, version.catalogNumber, version.country,
  ]
  return parts.filter(Boolean).join(' · ') || null
}

/**
 * The files' quality: "Hi-Res Lossless · FLAC 24-bit/96 kHz", "Lossless · ALAC 16-bit/44.1 kHz",
 * "MP3 · 320 kbps".
 */
export function versionQuality(quality: VersionQuality): string {
  const codec = codecLabel(quality.codec)
  if (quality.tier === 'lossy') return quality.bitrate ? `${codec} · ${formatBitrate(quality.bitrate)}` : codec
  const resolution = [quality.bitDepth ? `${quality.bitDepth}-bit` : null, quality.sampleRate ? formatSampleRate(quality.sampleRate) : null].filter(Boolean).join('/')
  return `${audioQualityLabel(quality.tier)} · ${resolution ? `${codec} ${resolution}` : codec}`
}

/** "12 songs", or "9 of 12 songs" for a version that lacks some. */
export function versionSongs(version: Pick<AlbumVersion, 'trackCount' | 'ownedTrackCount'>): string {
  return version.ownedTrackCount < version.trackCount
    ? `${version.ownedTrackCount.toLocaleString()} of ${plural(version.trackCount, 'song')}`
    : plural(version.trackCount, 'song')
}

/** One line for a version in a menu: its title, then its quality. */
export function versionLabel(version: AlbumVersion | TrackVersion): string {
  return `${versionTitle(version)} — ${versionQuality(version.quality)}`
}
