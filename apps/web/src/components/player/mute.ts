/**
 * The last volume heard on each device, which unmute goes back to. Kept apart from the
 * controls, so muting in the bar and unmuting in Now Playing, the devices list or with M agree.
 */
const audibleVolumes = new Map<string, number>()

export function rememberVolume(deviceId: string, volume: number) {
  audibleVolumes.set(deviceId, volume)
}

/** Mutes `deviceId`, or gives it back the last volume heard on it: the mute button's and the M key's. */
export function toggleMute(volume: number, deviceId: string, setVolume: (volume: number) => void) {
  if (volume) audibleVolumes.set(deviceId, volume)
  setVolume(volume ? 0 : audibleVolumes.get(deviceId) ?? 0.7)
}
