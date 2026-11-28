/** Common feedback returned by the services. Timestamps are Unix seconds. */
export type RemoteFeedback = {
  mbid?: string | null
  title?: string
  artist?: string
  at: number
  loved: boolean
}
