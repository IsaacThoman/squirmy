/** MIME types that prove a codec plays, in the server's codec vocabulary. Opus counts only in Ogg, the container the server sends. */
const probes: [codec: string, types: string[]][] = [
  ['flac', ['audio/flac', 'audio/x-flac']],
  ['mp3', ['audio/mpeg']],
  ['aac', ['audio/aac', 'audio/mp4; codecs="mp4a.40.2"']],
  ['alac', ['audio/mp4; codecs="alac"']],
  ['opus', ['audio/ogg; codecs="opus"']],
  ['vorbis', ['audio/ogg; codecs="vorbis"']],
  ['wav', ['audio/wav', 'audio/wave']],
  ['aiff', ['audio/aiff', 'audio/x-aiff']],
]

/** The codecs `audio` says it can decode ("maybe" counts; "" does not). */
export function codecsFor(audio: Pick<HTMLMediaElement, 'canPlayType'>): string[] {
  return probes.filter(([, types]) => types.some(type => audio.canPlayType(type) !== '')).map(([codec]) => codec)
}

let probed: string[] | null = null

/**
 * The codecs this browser really decodes, for `GET /tracks/:id/playback`. The server then
 * sends the original file only when it plays here and transcodes the rest.
 */
export function playableCodecs(): string[] {
  probed ??= codecsFor(document.createElement('audio'))
  return probed
}

/**
 * `SourceBuffer` types for the codecs of the server's Media Source Extensions vocabulary,
 * the first type the browser accepts winning: `mp3` is an MPEG byte stream and `mp3_mp4`
 * MP3 inside MP4 (Firefox's). WebKit takes FLAC in MP4 only as `fLaC`. Opus is left out:
 * one decoder runs across every track appended, and one encode's state spoils the start of
 * the next (docs/audio-engine.md, "Web measurements").
 */
const mseProbes: [codec: string, types: string[]][] = [
  ['flac', ['audio/mp4; codecs="flac"', 'audio/mp4; codecs="fLaC"']],
  ['aac', ['audio/mp4; codecs="mp4a.40.2"']],
  ['mp3_mp4', ['audio/mp4; codecs="mp3"']],
  ['mp3', ['audio/mpeg']],
]

/** The `SourceBuffer` type of each codec `isTypeSupported` accepts, keyed by codec. */
export function mseTypesFor(isTypeSupported: (type: string) => boolean): Map<string, string> {
  const types = new Map<string, string>()
  for (const [codec, candidates] of mseProbes) {
    const type = candidates.find(candidate => isTypeSupported(candidate))
    if (type) types.set(codec, type)
  }
  return types
}
