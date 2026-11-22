type ClientHints = { userAgentData?: { platform: string } }

/** Apple platforms use ⌘ where others use Ctrl. `navigator.platform` is on its way out; client hints replace it where they exist. */
export const isApple = /Mac|iPhone|iPad|iPod/.test((navigator as Navigator & ClientHints).userAgentData?.platform || navigator.platform || navigator.userAgent)

/** The modifier of the app's shortcuts, as shown beside them: "⌘K" or "Ctrl+K". */
export const modKey = isApple ? '⌘' : 'Ctrl+'
