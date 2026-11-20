import type { ICommonTagsResult, IFormat } from 'music-metadata'
import type { FileTags } from '../../database/schema.js'

/**
 * Every tag a file carries, keyed by a normalized name: container prefixes such as
 * `TXXX:`, `----:com.apple.iTunes:` and `WM/` removed, lowercased, punctuation and spaces
 * dropped. So `TXXX:MusicBrainz Album Id`, `MUSICBRAINZ_ALBUMID` and
 * `----:com.apple.iTunes:MusicBrainz Album Id` all become `musicbrainzalbumid`.
 */
export type RawTags = Map<string, string[]>

export function tagKey(id: string): string {
  return id.replace(/^(txxx:|----:com\.apple\.itunes:|wm\/)/i, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Builds `RawTags` from music-metadata's native tags or ffprobe's tag objects. */
export function rawTags(lists: Iterable<readonly { id: string; value: unknown }[]>): RawTags {
  const raw: RawTags = new Map()
  for (const list of lists) {
    for (const { id, value } of list) {
      const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined
      if (text === undefined || !text.trim()) continue
      const key = tagKey(id)
      raw.set(key, [...(raw.get(key) ?? []), text])
    }
  }
  return raw
}

export type Technical = {
  container: string
  codec: string
  lossless: boolean
  bitrate: number | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  durationMs: number
}

/** Containers by file extension, used until a file has been probed. */
export function containerFromExtension(extension: string): string {
  const ext = extension.toLowerCase()
  const known: Record<string, string> = { m4a: 'mp4', aac: 'aac', oga: 'ogg', opus: 'ogg', aif: 'aiff', wv: 'wavpack', wma: 'asf' }
  return known[ext] ?? ext
}

const losslessCodecs = new Set(['flac', 'alac', 'wav', 'aiff', 'wavpack', 'ape', 'dsd'])

/**
 * Codec names as clients list them (flac, mp3, aac, alac, opus, vorbis, wav, aiff) plus
 * wavpack, ape, wma and dsd. `name` is music-metadata's or ffprobe's codec name.
 */
export function normalizeCodec(name: string | undefined, extension: string): string {
  const value = (name ?? '').toLowerCase()
  const ext = extension.toLowerCase()
  if (value.includes('flac')) return 'flac'
  if (value.includes('layer 3') || value === 'mp3') return 'mp3'
  if (value.includes('alac')) return 'alac'
  if (value.includes('aac')) return 'aac'
  if (value.includes('vorbis')) return 'vorbis'
  if (value.includes('opus')) return 'opus'
  if (value.includes('wavpack')) return 'wavpack'
  if (value.includes('monkey') || value === 'ape') return 'ape'
  if (value.includes('wma') || value.includes('windows media')) return 'wma'
  if (value.includes('dsd')) return 'dsd'
  if (value.includes('pcm') || value === 'lpcm') return ext === 'aiff' || ext === 'aif' ? 'aiff' : 'wav'
  return value || 'unknown'
}

/** Container names: flac, mp3, mp4, aac, ogg, wav, aiff, wavpack, ape, asf, dsf. */
export function normalizeContainer(name: string | undefined, extension: string): string {
  const value = (name ?? '').toLowerCase()
  if (value.includes('flac')) return 'flac'
  if ((value.includes('mpeg') && !value.includes('mpeg-4')) || value === 'mp3') return 'mp3'
  if (value.includes('m4a') || value.includes('mp4') || value.includes('mov')) return 'mp4'
  if (value.includes('ogg')) return 'ogg'
  if (value.includes('wav') && !value.includes('wavpack')) return 'wav'
  if (value.includes('aiff')) return 'aiff'
  if (value.includes('wavpack') || value === 'wv') return 'wavpack'
  if (value.includes('monkey') || value === 'ape') return 'ape'
  if (value.includes('asf')) return 'asf'
  if (value.includes('dsf')) return 'dsf'
  return containerFromExtension(extension)
}

const positive = (value: number | undefined | null) => (value && Number.isFinite(value) && value > 0 ? value : null)

/** Technical details from music-metadata. The bitrate falls back to size over duration. */
export function technicalFromFormat(format: IFormat, extension: string, sizeBytes: number): Technical {
  const codec = normalizeCodec(format.codec, extension)
  const durationMs = Math.round((positive(format.duration) ?? 0) * 1000)
  const bitrate = positive(format.bitrate) ?? (durationMs > 0 ? (sizeBytes * 8 * 1000) / durationMs : null)
  return {
    container: normalizeContainer(format.container, extension),
    codec,
    lossless: format.lossless ?? losslessCodecs.has(codec),
    bitrate: bitrate === null ? null : Math.round(bitrate),
    sampleRate: positive(format.sampleRate),
    bitDepth: positive(format.bitsPerSample),
    channels: positive(format.numberOfChannels),
    durationMs,
  }
}

type FfprobeOutput = {
  format?: { format_name?: string; duration?: string; bit_rate?: string; tags?: Record<string, string> }
  streams?: { codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number; bits_per_raw_sample?: string; bits_per_sample?: number; tags?: Record<string, string> }[]
}

/** Technical details and tags from `ffprobe`, for files music-metadata cannot parse. */
export function fromFfprobe(output: unknown, extension: string, sizeBytes: number): { technical: Technical; raw: RawTags } | null {
  const probe = output as FfprobeOutput
  const stream = probe.streams?.find((candidate) => candidate.codec_type === 'audio')
  const durationMs = Math.round((positive(Number(probe.format?.duration)) ?? 0) * 1000)
  // ffprobe guesses a stream from the extension alone; without a duration nothing decoded.
  if (!stream || durationMs === 0) return null
  const codec = normalizeCodec(stream.codec_name, extension)
  const bitrate = positive(Number(probe.format?.bit_rate)) ?? (durationMs > 0 ? (sizeBytes * 8 * 1000) / durationMs : null)
  const bitDepth = positive(Number(stream.bits_per_raw_sample)) ?? positive(stream.bits_per_sample)
  const tagObjects = [probe.format?.tags ?? {}, stream.tags ?? {}]
  return {
    technical: {
      container: normalizeContainer(probe.format?.format_name, extension),
      codec,
      lossless: losslessCodecs.has(codec),
      bitrate: bitrate === null ? null : Math.round(bitrate),
      sampleRate: positive(Number(stream.sample_rate)),
      bitDepth,
      channels: positive(stream.channels),
      durationMs,
    },
    raw: rawTags(tagObjects.map((tags) => Object.entries(tags).map(([id, value]) => ({ id, value })))),
  }
}

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Every MusicBrainz id in the values, in order. Handles ids joined with `/` or `;`. */
function mbids(values: readonly string[] | string | undefined): string[] {
  const list = typeof values === 'string' ? [values] : values ?? []
  return [...new Set(list.flatMap((value) => value.match(uuidPattern) ?? []).map((id) => id.toLowerCase()))]
}

const clean = (value: string | undefined | null) => {
  const trimmed = value?.replace(/\0/g, '').trim()
  return trimmed ? trimmed : undefined
}

/** "5", "5/12" or "05 of 12" → [5, 12]. */
function numberPair(value: string | undefined): [number | undefined, number | undefined] {
  const match = value ? /^\s*(\d+)\s*(?:(?:\/|of)\s*(\d+))?/i.exec(value) : null
  const number = (text: string | undefined) => (text && Number(text) > 0 ? Number(text) : undefined)
  return [number(match?.[1]), number(match?.[2])]
}

/** The year in any date form: 2013, 2013-05-17, 17.05.2013, 05/17/2013, "May 2013". */
export function yearOf(value: string | undefined): number | undefined {
  const match = value ? /(?:^|\D)(1[89]\d\d|20\d\d|21\d\d)(?!\d)/.exec(value) : null
  return match ? Number(match[1]) : undefined
}

/** YYYY, YYYY-MM or YYYY-MM-DD when the value is in ISO order, otherwise just the year. */
export function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const iso = /^\s*(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(value)
  if (iso?.[1] && yearOf(iso[1])) return [iso[1], iso[2], iso[3]].filter(Boolean).join('-')
  const year = yearOf(value)
  return year ? String(year) : undefined
}

/**
 * Splits genre values on `;`, `|`, `\` and ` / `. Commas, `&` and a bare `/` are left alone:
 * "Folk, World, & Country", "R&B" and "Hip-Hop/Rap" are single genres.
 */
export function splitGenres(values: readonly string[] | undefined): string[] {
  const seen = new Map<string, string>()
  for (const value of values ?? []) {
    for (const part of value.split(/\s*[;|\\\0]\s*|\s+\/\s+/)) {
      const genre = part.trim()
      if (genre && !seen.has(genre.toLowerCase())) seen.set(genre.toLowerCase(), genre)
    }
  }
  return [...seen.values()]
}

const isrcPattern = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/

function isrcList(values: readonly string[] | undefined): string[] {
  const codes = (values ?? []).flatMap((value) => value.split(/[;,/\s\0]+/)).map((code) => code.replace(/-/g, '').toUpperCase())
  return [...new Set(codes.filter((code) => isrcPattern.test(code)))]
}

const truthy = (value: string | undefined) => (value === undefined ? undefined : /^(1|true|yes)$/i.test(value.trim()))

/**
 * The multi-value artists tag (Picard's ARTISTS, or a repeated ARTIST field) when the file
 * has one. Values are split on `;` and NUL only, never on `/` (AC/DC).
 */
function artistList(raw: RawTags): string[] | undefined {
  const explicit = raw.get('artists')
  const repeated = raw.get('artist')
  const values = explicit ?? (repeated && repeated.length > 1 ? repeated : undefined)
  const names = values?.flatMap((value) => value.split(/\s*[;\0]\s*/)).map((name) => name.trim()).filter(Boolean)
  return names && names.length > 0 ? names : undefined
}

/**
 * Normalizes what a file says about itself. `common` is music-metadata's mapping;
 * `raw` fills the gaps, which matters for tags written under non-Picard names (ffmpeg
 * and foobar2000 write `TXXX:MUSICBRAINZ_ALBUMID` in MP3s, which music-metadata does not
 * map).
 *
 * MusicBrainz naming quirk: Vorbis, APE and MP4 store the *recording* id under
 * "MusicBrainz Track Id" and the track id under "MusicBrainz Release Track Id"; ID3 stores
 * the recording id in the `UFID` frame. Any "track id" without "release" is a recording id.
 */
export function normalizeTags(common: Partial<ICommonTagsResult>, raw: RawTags): FileTags {
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = raw.get(key)?.map(clean).find(Boolean)
      if (value) return value
    }
    return undefined
  }
  const [track, trackOf] = common.track?.no ? [common.track.no, common.track.of ?? undefined] : numberPair(first('track', 'tracknumber'))
  const [disc, discOf] = common.disk?.no ? [common.disk.no, common.disk.of ?? undefined] : numberPair(first('disc', 'discnumber', 'disk'))
  const date = normalizeDate(clean(common.date) ?? clean(common.releasedate) ?? first('date', 'year', 'originaldate'))
  const artists = artistList(raw)
  const tags: FileTags = {
    title: clean(common.title) ?? first('title'),
    artist: clean(common.artist) ?? first('artist') ?? (artists ? artists.join(', ') : undefined),
    artists: artists && artists.length > 1 ? artists : undefined,
    album: clean(common.album) ?? first('album'),
    albumArtist: clean(common.albumartist) ?? first('albumartist'),
    date,
    year: common.year ?? yearOf(date) ?? yearOf(clean(common.originaldate)),
    track,
    trackTotal: trackOf ?? numberPair(first('totaltracks', 'tracktotal'))[0],
    disc,
    discTotal: discOf ?? numberPair(first('totaldiscs', 'disctotal'))[0],
    genres: splitGenres(common.genre ?? raw.get('genre')),
    compilation: common.compilation ?? truthy(first('compilation', 'tcmp', 'cpil', 'itunescompilation')),
    isrcs: isrcList(common.isrc ?? raw.get('isrc') ?? raw.get('tsrc')),
    barcode: clean(common.barcode) ?? first('barcode', 'upc', 'ean'),
    label: clean(common.label?.[0]) ?? first('label', 'organization', 'publisher'),
    catalogNumber: clean(common.catalognumber?.[0]) ?? first('catalognumber', 'catalogid'),
    mbRecordingId: mbids(common.musicbrainz_recordingid ?? first('musicbrainzrecordingid', 'musicbrainztrackid'))[0],
    mbTrackId: mbids(common.musicbrainz_trackid ?? first('musicbrainzreleasetrackid'))[0],
    mbReleaseId: mbids(common.musicbrainz_albumid ?? first('musicbrainzalbumid', 'musicbrainzreleaseid'))[0],
    mbReleaseGroupId: mbids(common.musicbrainz_releasegroupid ?? first('musicbrainzreleasegroupid'))[0],
    mbArtistIds: mbids(common.musicbrainz_artistid ?? raw.get('musicbrainzartistid')),
    mbAlbumArtistIds: mbids(common.musicbrainz_albumartistid ?? raw.get('musicbrainzalbumartistid')),
    hasLyrics: common.lyrics?.some((lyrics) => Boolean(lyrics.text?.trim() || lyrics.syncText?.length)) || undefined,
  }
  // Keep the stored JSON small: drop empty values.
  return Object.fromEntries(Object.entries(tags).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))) as FileTags
}

export type Gains = { trackGainDb: number | null; trackPeak: number | null; albumGainDb: number | null; albumPeak: number | null }

const decibels = (value: string | undefined) => {
  const number = value === undefined ? NaN : Number.parseFloat(value)
  return Number.isFinite(number) ? number : null
}

/**
 * ReplayGain values from the file's tags. Opus files carry R128_TRACK_GAIN /
 * R128_ALBUM_GAIN instead: Q7.8 fixed point relative to −23 LUFS, converted here to the
 * ReplayGain reference of −18 LUFS by adding 5 dB.
 */
export function readGains(common: Partial<ICommonTagsResult>, raw: RawTags): Gains {
  const rawValue = (key: string) => raw.get(key)?.[0]
  const r128 = (key: string) => {
    const value = decibels(rawValue(key))
    return value === null ? null : Math.round((value / 256 + 5) * 100) / 100
  }
  return {
    trackGainDb: common.replaygain_track_gain?.dB ?? decibels(rawValue('replaygaintrackgain')) ?? r128('r128trackgain'),
    trackPeak: common.replaygain_track_peak?.ratio ?? decibels(rawValue('replaygaintrackpeak')),
    albumGainDb: common.replaygain_album_gain?.dB ?? decibels(rawValue('replaygainalbumgain')) ?? r128('r128albumgain'),
    albumPeak: common.replaygain_album_peak?.ratio ?? decibels(rawValue('replaygainalbumpeak')),
  }
}
