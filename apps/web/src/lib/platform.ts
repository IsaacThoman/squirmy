/** Apple platforms use ⌘ where others use Ctrl. */
export const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

/** The modifier of the app's shortcuts, as shown beside them: "⌘K" or "Ctrl+K". */
export const modKey = isApple ? '⌘' : 'Ctrl+'
