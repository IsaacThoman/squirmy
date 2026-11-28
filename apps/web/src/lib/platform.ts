type ClientHints = { userAgentData?: { platform: string } }

/** Whether a platform name is Apple's: "MacIntel" from `navigator.platform`, "macOS" from client hints. */
export const isApplePlatform = (platform: string) => /mac|iphone|ipad|ipod/i.test(platform)

/**
 * Apple platforms use ⌘ where others use Ctrl. `navigator.platform` is on its way out; client
 * hints replace it where they exist, and say "macOS" in Chrome on a Mac, so the match ignores case.
 */
export const isApple = isApplePlatform((navigator as Navigator & ClientHints).userAgentData?.platform || navigator.platform || navigator.userAgent)

/** The modifier of the app's shortcuts, as shown beside them: "⌘K" or "Ctrl+K". */
export const modKey = isApple ? '⌘' : 'Ctrl+'
