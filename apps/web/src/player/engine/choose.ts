import { CrossfadeEngine } from './crossfade-engine'
import { MseEngine } from './mse-engine'
import type { BrowserEngine } from './types'
import { WebPlayerEngine } from './web-engine'

type ClientHints = { userAgentData?: { brands?: { brand: string }[] } }

/**
 * Whether this browser's Media Source Extensions place and trim each track to the sample:
 * Chromium, measured with docs/audio-engine.md's split tone. Firefox (it drops frames that
 * straddle an append window) and Safari stay on `WebPlayerEngine` until they measure exact.
 * Client hints exist only in secure contexts, so plain HTTP on a LAN reads the user agent.
 */
export function playsGaplessThroughMse(navigator: Pick<Navigator, 'userAgent'> & ClientHints): boolean {
  const brands = navigator.userAgentData?.brands
  if (brands?.length) return brands.some(({ brand }) => brand === 'Chromium')
  // iOS browsers are WebKit whatever their name (CriOS, EdgiOS), and say so without "Chrome/".
  return /\bChrom(e|ium)\/\d/.test(navigator.userAgent) && !/\b(CriOS|EdgiOS|FxiOS)\//.test(navigator.userAgent)
}

/**
 * The page's engine: one gapless timeline where the browser measured exact, today's two
 * elements elsewhere, either of them twice over so songs can crossfade.
 */
export function createBrowserEngine(): BrowserEngine {
  const mse = typeof navigator !== 'undefined' && playsGaplessThroughMse(navigator) && MseEngine.isSupported()
  return new CrossfadeEngine({ createEngine: options => (mse ? new MseEngine(options) : new WebPlayerEngine(options)) })
}
