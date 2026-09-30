import { extractProtected } from './markdown'
import type { OutboxEntry, Segment, TranslationConflict } from './types'

const OUTBOX_KEY = 'sologsb-1003-outbox-v1'
const BASE_KEY = 'sologsb-1003-sync-base-v1'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export interface MergeStats {
  unchanged: number
  autoMergedLocal: number
  autoMergedRemote: number
  conflicts: number
  tokenWarnings: string[]
}

export interface MergeResult {
  segments: Segment[]
  conflicts: TranslationConflict[]
  stats: MergeStats
}

/**
 * Re-inject any protected tokens (variables, link URLs) that exist in the
 * source but were dropped from `text`. Tokens are re-inserted using a small
 * context window taken from the base text; when no anchor is found the token
 * is appended and a warning is returned so the translator can place it.
 */
export function preserveTokens(
  text: string,
  sourceText: string,
  baseText: string,
): { text: string; warnings: string[] } {
  const tokens = extractProtected(sourceText)
  if (!tokens.length) return { text, warnings: [] }
  let result = text
  const warnings: string[] = []
  for (const token of tokens) {
    if (result.includes(token)) continue
    const restored = reinjectToken(result, token, baseText)
    if (restored !== result) {
      result = restored
      warnings.push(`已恢复受保护标记：${token}`)
    } else {
      result = `${result.trimEnd()} ${token}`
      warnings.push(`受保护标记已追加到片段末尾，请调整位置：${token}`)
    }
  }
  return { text: result, warnings }
}

function reinjectToken(text: string, token: string, baseText: string): string {
  const at = baseText.indexOf(token)
  if (at === -1) return text
  const before = baseText.slice(Math.max(0, at - 24), at).trim()
  const after = baseText.slice(at + token.length, Math.min(baseText.length, at + token.length + 24)).trim()
  if (before && text.includes(before)) {
    const pos = text.indexOf(before) + before.length
    return `${text.slice(0, pos)} ${token}${text.slice(pos)}`
  }
  if (after && text.includes(after)) {
    const pos = text.indexOf(after)
    return `${text.slice(0, pos)}${token} ${text.slice(pos)}`
  }
  return text
}

/**
 * Three-way reconcile of local (offline) edits with the remote document.
 *
 * - neither side changed            -> keep as-is
 * - only local changed              -> take the local version (token-safe)
 * - only remote changed             -> adopt the remote version (token-safe)
 * - both sides changed              -> keep the local edit and surface the
 *                                      remote version as a conflict for the
 *                                      translator to pick
 */
export function mergeDocument(
  base: Segment[],
  local: Segment[],
  remote: Segment[],
): MergeResult {
  const baseMap = new Map(base.map((segment) => [segment.id, segment]))
  const remoteMap = new Map(remote.map((segment) => [segment.id, segment]))
  const conflicts: TranslationConflict[] = []
  const stats: MergeStats = { unchanged: 0, autoMergedLocal: 0, autoMergedRemote: 0, conflicts: 0, tokenWarnings: [] }

  const segments: Segment[] = local.map((segment) => {
    const baseSegment = baseMap.get(segment.id)
    const remoteSegment = remoteMap.get(segment.id)
    if (!baseSegment || !remoteSegment) {
      stats.unchanged++
      return segment
    }
    const localChanged = segment.targetText !== baseSegment.targetText
    const remoteChanged = remoteSegment.targetText !== baseSegment.targetText

    if (!localChanged && !remoteChanged) {
      stats.unchanged++
      return segment
    }

    if (localChanged && !remoteChanged) {
      const { text, warnings } = preserveTokens(segment.targetText, segment.sourceText, baseSegment.targetText)
      stats.autoMergedLocal++
      stats.tokenWarnings.push(...warnings)
      return text === segment.targetText ? segment : { ...segment, targetText: text }
    }

    if (!localChanged && remoteChanged) {
      const { text, warnings } = preserveTokens(remoteSegment.targetText, segment.sourceText, baseSegment.targetText)
      stats.autoMergedRemote++
      stats.tokenWarnings.push(...warnings)
      return { ...segment, targetText: text, status: remoteSegment.status ?? segment.status }
    }

    // Both sides changed — keep the local edit and present both versions.
    conflicts.push({
      id: `sync-${segment.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      segmentId: segment.id,
      baseText: baseSegment.targetText,
      localText: segment.targetText,
      remoteText: remoteSegment.targetText,
      remoteAuthor: '远端协作者',
      createdAt: Date.now(),
    })
    stats.conflicts++
    return segment
  })

  // New segments introduced by a colleague on the remote side.
  for (const remoteSegment of remote) {
    if (!local.some((segment) => segment.id === remoteSegment.id)) {
      segments.push(clone(remoteSegment))
      stats.autoMergedRemote++
    }
  }

  return { segments, conflicts, stats }
}

/** Build (or refresh) an outbox entry for a segment edited offline. */
export function buildOutboxEntry(
  segment: Segment,
  baseText: string,
  previous?: OutboxEntry,
): OutboxEntry | null {
  if (segment.targetText === baseText) return null
  return {
    segmentId: segment.id,
    baseText,
    localText: segment.targetText,
    // A fresh edit is always ready to push again; keep attempt history.
    status: 'pending',
    attempts: previous?.attempts ?? 0,
    lastError: undefined,
    queuedAt: previous?.queuedAt ?? Date.now(),
  }
}

export const upsertOutboxEntry = (entries: OutboxEntry[], entry: OutboxEntry): OutboxEntry[] => {
  const others = entries.filter((item) => item.segmentId !== entry.segmentId)
  return [...others, entry].sort((a, b) => a.queuedAt - b.queuedAt)
}

export const removeOutboxEntry = (entries: OutboxEntry[], segmentId: string): OutboxEntry[] =>
  entries.filter((entry) => entry.segmentId !== segmentId)

export const markOutboxEntry = (
  entries: OutboxEntry[],
  segmentId: string,
  patch: Partial<OutboxEntry>,
): OutboxEntry[] =>
  entries.map((entry) => entry.segmentId === segmentId ? { ...entry, ...patch } : entry)

export const loadOutbox = (): OutboxEntry[] => {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as OutboxEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export const saveOutbox = (entries: OutboxEntry[]): void => {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries)) } catch { /* storage unavailable */ }
}

export const loadBaseSegments = (fallback: Segment[]): Segment[] => {
  try {
    const raw = localStorage.getItem(BASE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Segment[]
    return Array.isArray(parsed) && parsed.length ? parsed : fallback
  } catch {
    return fallback
  }
}

export const saveBaseSegments = (segments: Segment[]): void => {
  try { localStorage.setItem(BASE_KEY, JSON.stringify(segments)) } catch { /* storage unavailable */ }
}
