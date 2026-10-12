/** Default title a conversation gets on creation (see
 * `ConversationRepository.create`). Only conversations still carrying it
 * are auto-titled — a user's own rename is never overwritten. */
export const DEFAULT_SESSION_TITLE = 'New conversation'

const MAX_WORDS = 6
const MAX_CHARS = 60

/**
 * Derives a session title from the first user message: first ~6 words,
 * markdown/code noise stripped, trimmed to 60 chars. No model call.
 * Returns the default title for input with no usable words.
 */
export function deriveSessionTitle(firstMessage: string): string {
  const text = firstMessage
    .replace(/```[\s\S]*?(```|$)/g, ' ') // fenced code blocks
    .replace(/`([^`]*)`/g, '$1') // inline code markers
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links/images → their text
    .replace(/^[#>\-*+\d.\s]+/gm, ' ') // heading/quote/list markers at line start
    .replace(/[*_~]+/g, '') // emphasis markers
    .replace(/\s+/g, ' ')
    .trim()

  const words = text.split(' ').filter(Boolean)
  if (words.length === 0) return DEFAULT_SESSION_TITLE

  let title = words.slice(0, MAX_WORDS).join(' ')
  title = title.replace(/[\s,;:.!?-]+$/, '')
  if (title.length > MAX_CHARS) title = `${title.slice(0, MAX_CHARS - 1).trimEnd()}…`
  else if (words.length > MAX_WORDS) title = `${title}…`
  return title || DEFAULT_SESSION_TITLE
}
