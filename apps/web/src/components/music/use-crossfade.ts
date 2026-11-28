import { useEffect, useState } from 'react'

/**
 * The layers a changing picture draws, oldest first: the one before stays under the new one
 * until that one has come in (`shown`) and faded up over `fadeMs`, then goes. A track change so
 * never shows an empty frame or a flash of the placeholder. A third change while one is fading
 * drops the oldest.
 */
export function useCrossfade<T extends { id: string }>(item: T | null, fadeMs: number) {
  const [layers, setLayers] = useState<(T | null)[]>([item])
  const [ready, setReady] = useState<string | null>(null)
  const top = layers[layers.length - 1] ?? null
  const id = item?.id ?? null
  if ((top?.id ?? null) !== id) setLayers([top, item])
  // The same picture with newer details (a color, a hash) replaces its layer in place.
  else if (top !== item) setLayers([...layers.slice(0, -1), item])
  const fading = layers.length > 1
  useEffect(() => {
    if (!fading || ready !== id) return
    const timer = setTimeout(() => setLayers(current => current.slice(-1)), fadeMs)
    return () => clearTimeout(timer)
  }, [fading, ready, id, fadeMs])
  return { layers, fading, shown: setReady }
}
