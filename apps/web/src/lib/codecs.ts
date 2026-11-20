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
