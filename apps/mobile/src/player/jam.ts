/** The jam's id from an invite link (`…/jam/<id>`), or the id itself when that is what was pasted; null for anything else. */
export function jamIdFrom(text: string): string | null {
  const trimmed = text.trim();
  const match = /\/jam\/([^/?#\s]+)/.exec(trimmed);
  let id = trimmed;
  if (match) {
    try {
      id = decodeURIComponent(match[1]!);
    } catch {
      return null;
    }
  }
  return /^[\w-]{16,64}$/.test(id) ? id : null;
}
