import type { Message } from '@ai-workspace/shared'

/**
 * Turns the flat message list into what the thread renders. Replies that share
 * a `replyGroupId` and were produced by compare / review / round table are
 * gathered into one block placed where the group's first reply sits; everything
 * else (plain chat, Auto, regenerate siblings, rows from before orchestration)
 * stays an ordinary one-reply item in thread order.
 */
export type ThreadItem =
  | { kind: 'user'; message: Message }
  | {
      kind: 'reply'
      message: Message
      /** Replies sharing this one's group (>1 means regenerated siblings). */
      siblingCount: number
    }
  | { kind: 'compare'; groupId: string; replies: Message[] }
  | {
      kind: 'review'
      groupId: string
      /** The primary model's answer (never edited after it was written). */
      primary: Message | null
      reviews: Message[]
      /** `[apply suggestions]` results and other later siblings. */
      revisions: Message[]
    }
  | { kind: 'roundtable'; groupId: string; turns: Message[] }

type GroupKind = 'compare' | 'review' | 'roundtable'

function groupKindOf(replies: Message[]): GroupKind | null {
  for (const reply of replies) {
    if (reply.orchestrationMode === 'compare') return 'compare'
    if (reply.orchestrationMode === 'review') return 'review'
    if (reply.orchestrationMode === 'roundtable') return 'roundtable'
  }
  return null
}

function byIndex(a: Message, b: Message): number {
  return (a.replyIndex ?? 0) - (b.replyIndex ?? 0) || a.createdAt - b.createdAt
}

export function buildThread(messages: Message[]): ThreadItem[] {
  const repliesByGroup = new Map<string, Message[]>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.replyGroupId) continue
    const list = repliesByGroup.get(message.replyGroupId) ?? []
    list.push(message)
    repliesByGroup.set(message.replyGroupId, list)
  }

  const items: ThreadItem[] = []
  const placed = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant') {
      items.push({ kind: 'user', message })
      continue
    }
    const groupId = message.replyGroupId
    const group = groupId ? (repliesByGroup.get(groupId) ?? [message]) : [message]
    const kind = groupId ? groupKindOf(group) : null
    if (!groupId || !kind) {
      items.push({ kind: 'reply', message, siblingCount: group.length })
      continue
    }
    if (placed.has(groupId)) continue
    placed.add(groupId)
    const ordered = [...group].sort(byIndex)
    if (kind === 'compare') {
      items.push({ kind: 'compare', groupId, replies: ordered })
    } else if (kind === 'roundtable') {
      items.push({ kind: 'roundtable', groupId, turns: ordered })
    } else {
      const primary = ordered.find((m) => m.roleLabel === null && m.orchestrationMode === 'review') ?? null
      items.push({
        kind: 'review',
        groupId,
        primary,
        reviews: ordered.filter((m) => m.roleLabel === 'review'),
        revisions: ordered.filter((m) => m !== primary && m.roleLabel !== 'review'),
      })
    }
  }
  return items
}

/** The reply a "keep typing" turn will continue from, per group: used for the
 * "IN CONTEXT" marks. null when nothing in the group is in context. */
export function inContextReply(replies: Message[]): Message | null {
  return replies.find((m) => m.inContext) ?? null
}
