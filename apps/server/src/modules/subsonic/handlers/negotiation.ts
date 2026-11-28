import path from 'node:path'
import { StreamIntent, UserSettings, type StreamQuality } from '@squirmy/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../../database/client.js'
import { mediaFiles } from '../../../database/schema.js'
import { sign, verify } from '../../../lib/crypto.js'
import { assertFileAllowed } from '../../catalog/explicit.js'
import { openStream, selectFile, streamSignal } from '../../streaming/index.js'
import {
  codecFamily, outputBitDepth, outputSampleRate, profiles, type MediaFile, type TranscodeProfile,
} from '../../streaming/profiles.js'
import { expectId } from '../ids.js'
import { invalidParameter, notFound, sent, type Context, type Handler } from '../protocol.js'
import { resolve } from './browsing.js'

const identifier = z.string().trim().min(1).max(128)
const channelLimit = z.number().int().positive().optional()
const bitrateLimit = z.number().int().nonnegative().optional()
const limitation = z.object({
  name: identifier,
  comparison: z.enum(['Equals', 'NotEquals', 'LessThanEqual', 'GreaterThanEqual']),
  values: z.union([identifier, z.array(identifier).min(1).max(64)]).transform((value) => [value].flat()),
  required: z.boolean(),
})
const clientInfo = z.object({
  name: identifier,
  platform: identifier,
  maxAudioBitrate: bitrateLimit,
  maxTranscodingAudioBitrate: bitrateLimit,
  directPlayProfiles: z.array(z.object({
    containers: z.array(identifier).max(64),
    audioCodecs: z.array(identifier).max(64),
    protocols: z.array(identifier).max(64),
    maxAudioChannels: channelLimit,
  })).max(64).default([]),
  transcodingProfiles: z.array(z.object({
    container: identifier,
    audioCodec: identifier,
    protocol: identifier,
    maxAudioChannels: channelLimit,
  })).max(64).default([]),
  codecProfiles: z.array(z.object({
    type: identifier,
    name: identifier,
    limitations: z.array(limitation).max(64).default([]),
  })).max(64).default([]),
})

type ClientInfo = z.infer<typeof clientInfo>
type StreamDetails = {
  protocol: 'http'
  container: string
  codec: string
  audioChannels: number | null
  audioBitrate: number | null
  audioSamplerate: number | null
  audioBitdepth: number | null
}

const container = (value: string) => {
  const name = value.toLowerCase()
  if (['m4a', 'm4b', 'fmp4'].includes(name)) return 'mp4'
  if (['opus', 'oga'].includes(name)) return 'ogg'
  if (name === 'adts') return 'aac'
  if (['aif', 'aifc'].includes(name)) return 'aiff'
  return name
}

function sourceDetails(file: MediaFile): StreamDetails {
  return {
    protocol: 'http',
    container: container(path.extname(file.relPath).slice(1) || file.container),
    codec: codecFamily(file),
    audioChannels: file.channels,
    audioBitrate: file.bitrate,
    audioSamplerate: file.sampleRate,
    audioBitdepth: file.bitDepth,
  }
}

function codecCompatible(info: ClientInfo, stream: StreamDetails): boolean {
  return info.codecProfiles.filter((profile) => profile.type === 'AudioCodec' && profile.name.toLowerCase() === stream.codec)
    .every((profile) => profile.limitations.every(({ name, values, comparison, required }) => {
      const actual = Object.hasOwn(stream, name) ? stream[name as keyof StreamDetails] : undefined
      if (actual == null) return !required
      if (comparison === 'Equals') return values.includes(String(actual))
      if (comparison === 'NotEquals') return !values.includes(String(actual))
      if (typeof actual !== 'number' || !Number.isFinite(Number(values[0]))) return !required
      return comparison === 'LessThanEqual' ? actual <= Number(values[0]) : actual >= Number(values[0])
    }))
}

const includes = (values: string[], actual: string, normalize = (value: string) => value.toLowerCase()) =>
  values.length === 0 || values.some((value) => normalize(value) === actual)

const within = (actual: number | null, max: number | undefined) => !max || (actual !== null && actual <= max)

/** The negotiated device does not report a network type. Apply the user's default streaming quality. */
function qualityAllows(file: MediaFile, stream: StreamDetails, quality: StreamQuality, profile?: TranscodeProfile): boolean {
  if (quality === 'original') return true
  if (profile === 'flac_mp4' || ((!profile || profile === 'copy_mp4') && file.lossless)) return false
  const saver = quality === 'data_saver'
  const caps: Record<string, number> = {
    aac: saver ? 128_000 : 256_000,
    mp3: saver ? 192_000 : 320_000,
    opus: saver ? (stream.container === 'mp4' ? 96_000 : 128_000) : 192_000,
  }
  return within(stream.audioBitrate, caps[stream.codec] ?? (saver ? 128_000 : 256_000))
}

function directReason(file: MediaFile, source: StreamDetails, info: ClientInfo, direct: ClientInfo['directPlayProfiles'][number], quality: StreamQuality) {
  if (!includes(direct.protocols, source.protocol)) return 'ProtocolNotSupported'
  if (!includes(direct.containers, source.container, container)) return 'ContainerNotSupported'
  if (!includes(direct.audioCodecs, source.codec)) return 'AudioCodecNotSupported'
  if (!within(source.audioChannels, direct.maxAudioChannels)) return 'AudioChannelsNotSupported'
  if (!within(source.audioBitrate, info.maxAudioBitrate)) return 'AudioBitrateNotSupported'
  if (!codecCompatible(info, source)) return 'AudioCodecLimitation'
  if (!qualityAllows(file, source, quality)) return 'UserQualityLimit'
  return undefined
}

function targetDetails(file: MediaFile, source: StreamDetails, profile: TranscodeProfile): StreamDetails | null {
  if (profile === 'copy_mp4') {
    if (!['aac', 'flac', 'mp3'].includes(source.codec) || source.container === 'mp4') return null
    return { ...source, container: 'mp4' }
  }
  const target = profiles[profile]
  return {
    protocol: 'http',
    container: container(target.extension),
    codec: target.codec,
    audioChannels: target.codec === 'mp3' && source.audioChannels ? Math.min(2, source.audioChannels) : source.audioChannels,
    audioBitrate: target.bitrate,
    audioSamplerate: outputSampleRate(file, profile),
    audioBitdepth: outputBitDepth(file, profile),
  }
}

const orderedProfiles = [
  'copy_mp4', 'flac_mp4', 'aac_mp4_256', 'aac_mp4_128', 'opus_mp4_192', 'opus_mp4_96',
  'aac_256', 'opus_128', 'mp3_320', 'mp3_192',
] satisfies TranscodeProfile[]

function targetFor(file: MediaFile, source: StreamDetails, info: ClientInfo, quality: StreamQuality) {
  for (const want of info.transcodingProfiles) {
    if (want.protocol.toLowerCase() !== 'http') continue
    for (const profile of orderedProfiles) {
      const stream = targetDetails(file, source, profile)
      if (!stream || stream.container !== container(want.container) || stream.codec !== want.audioCodec.toLowerCase()) continue
      if (!within(stream.audioChannels, want.maxAudioChannels) || !within(stream.audioBitrate, info.maxAudioBitrate)
        || !within(stream.audioBitrate, info.maxTranscodingAudioBitrate) || !codecCompatible(info, stream)
        || !qualityAllows(file, stream, quality, profile)) continue
      return { profile, stream }
    }
  }
  return undefined
}

const tokenPurpose = 'subsonic-transcode'
const tokenAgeSeconds = 86_400

function songId({ params }: Context) {
  const id = params.required('mediaId')
  if (params.required('mediaType') !== 'song') throw notFound('Media')
  return resolve('track', expectId(id, 'track').id)
}

async function selectedSong(context: Context) {
  const recordingId = await songId(context)
  const selection = await selectFile(recordingId, { quality: 'original' })
  if (!selection) throw notFound('Song')
  await assertFileAllowed(context.user.id, selection.file)
  return selection.file
}

async function getTranscodeDecision(context: Context) {
  const { request, user } = context
  const info = clientInfo.safeParse(request.body)
  if (!info.success) throw invalidParameter('ClientInfo')
  const file = await selectedSong(context)
  const { qualityWifi } = UserSettings.parse(user.settings)
  const sourceStream = sourceDetails(file)
  const reasons = info.data.directPlayProfiles.map((direct) => directReason(file, sourceStream, info.data, direct, qualityWifi))
  if (reasons.includes(undefined)) return { transcodeDecision: { canDirectPlay: true, canTranscode: false, sourceStream } }
  const target = targetFor(file, sourceStream, info.data, qualityWifi)
  const decision = {
    canDirectPlay: false,
    canTranscode: target !== undefined,
    sourceStream,
    transcodeReason: reasons,
  }
  if (!target) return { transcodeDecision: { ...decision, errorReason: 'No compatible transcoding profile' } }
  const expires = Math.floor(Date.now() / 1000) + tokenAgeSeconds
  const params = `${target.profile}.${expires}.${file.id}`
  const signature = sign(tokenPurpose, `${user.id}:${params}`)
  return {
    transcodeDecision: { ...decision, transcodeStream: target.stream, transcodeParams: `${params}.${signature}` },
  }
}

async function getTranscodeStream(context: Context): Promise<typeof sent> {
  const { request, reply, params, user } = context
  const [profile, expires, fileId, signature, extra] = params.required('transcodeParams').split('.')
  if (!fileId || !z.uuid().safeParse(fileId).success || !profile || !Object.hasOwn(profiles, profile) || !expires || !/^\d+$/.test(expires)
    || Number(expires) < Math.floor(Date.now() / 1000) || !signature || extra !== undefined) throw invalidParameter('transcodeParams')
  if (!verify(tokenPurpose, `${user.id}:${profile}.${expires}.${fileId}`, signature)) throw invalidParameter('transcodeParams')
  const recordingId = await songId(context)
  const [file] = await db.select().from(mediaFiles).where(and(eq(mediaFiles.id, fileId), isNull(mediaFiles.missingSince)))
  if (!file) throw notFound('Song')
  if (file.recordingId !== recordingId) throw invalidParameter('transcodeParams')
  await assertFileAllowed(user.id, file)
  const offset = params.string('offset') ?? '0'
  if (!/^\d+(?:\.\d+)?$/.test(offset)) throw invalidParameter('offset')
  const startMs = Math.round(Number(offset) * 1000)
  if (!Number.isSafeInteger(startMs) || (startMs > 0 && startMs >= file.durationMs)) throw invalidParameter('offset')
  const intent = StreamIntent.safeParse(params.string('intent') ?? 'play')
  if (!intent.success) throw invalidParameter('intent')
  const response = await openStream(file, profile as TranscodeProfile, {
    range: startMs ? undefined : request.headers.range,
    ifRange: [request.headers['if-range']].flat()[0],
    head: request.method === 'HEAD',
    startMs: startMs || undefined,
    intent: intent.data,
    userId: user.id,
    signal: streamSignal(reply.raw),
  })
  await reply.code(response.status).headers(response.headers).send(response.body ?? undefined)
  return sent
}

export const negotiationEndpoints: Record<string, Handler> = { getTranscodeDecision, getTranscodeStream }
