import { extractProtected } from '@/lib/markdown'
import type {
  PendingSegmentChange, RemoteSegmentState, Segment, SegmentStatus, SyncItemResult,
  SyncedSegmentSnapshot, TranslationConflict,
} from '@/lib/types'

export interface SyncPlanInput {
  segments: Segment[]
  /** 各片段最近一次同步成功的基线（片段 id -> 基线快照）。 */
  baseline: Record<string, SyncedSegmentSnapshot>
  /** 本地待同步队列。 */
  outbox: PendingSegmentChange[]
  /** 服务端逐片段的处理结果。 */
  results: SyncItemResult[]
  /** 远端文档的全量片段状态。 */
  remote: RemoteSegmentState[]
  now?: number
}

export interface SyncPlan {
  /** 对账合并后的完整片段列表。 */
  segments: Segment[]
  /** 成功落盘的片段，其基线推进到新版本。 */
  nextBaseline: Record<string, SyncedSegmentSnapshot>
  /** 被拒绝 / 仍待重试 / 被冲突挂起的条目；成功条目从队列移除。 */
  nextOutbox: PendingSegmentChange[]
  conflicts: TranslationConflict[]
  /** 被远端拒绝、需要回退到同步前样子的片段。 */
  rollbacks: { segmentId: string; text: string; status: SegmentStatus }[]
  /** 本次新拉取（只有远端动过）的片段。 */
  pulled: { segmentId: string; text: string; status: SegmentStatus }[]
  rejected: SyncItemResult[]
  accepted: SyncItemResult[]
}

const conflictId = (segmentId: string) => `conflict-${segmentId}`
const textStatusChanged = (snapshot: SyncedSegmentSnapshot | undefined, text: string, status: SegmentStatus) =>
  !snapshot || snapshot.targetText !== text || snapshot.status !== status

/** 改动文本相对基线是否丢失了受保护标记（占位符、链接）。 */
export const dropsProtectedTokens = (baseText: string, changedText: string) => {
  const base = extractProtected(baseText)
  const changed = new Set(extractProtected(changedText))
  return base.filter((token) => !changed.has(token))
}

const makeConflict = (
  segmentId: string,
  localText: string,
  localStatus: SegmentStatus,
  remote: RemoteSegmentState,
  reason: TranslationConflict['reason'],
  protectTokens: string[],
  now: number,
): TranslationConflict => ({
  id: conflictId(segmentId),
  segmentId,
  localText,
  remoteText: remote.targetText,
  remoteAuthor: remote.author,
  createdAt: now,
  localStatus,
  remoteStatus: remote.status,
  reason,
  protectTokens,
})

/**
 * 三向对账：以 baseline 为共同基线，逐片段合并本地队列与远端状态。
 *
 * - 两边都动过：服务端返回 conflict，保留两版让人挑，本地暂不改动。
 * - 只有本地动过且服务端接受：本地版本落盘并推进基线。
 * - 远端拒绝（如占位符被改没）：片段回退到同步前的本地样子，条目留队列重试。
 * - 只有远端动过：直接采用远端版本；但若远端版本丢了占位符/链接，不自动冲掉，转冲突。
 * - 两边都没动：保持基线。
 */
export const planSyncMerge = (input: SyncPlanInput): SyncPlan => {
  const now = input.now ?? Date.now()
  const segmentMap = new Map(input.segments.map((segment) => [segment.id, segment]))
  const remoteMap = new Map(input.remote.map((state) => [state.segmentId, state]))
  const resultMap = new Map(input.results.map((result) => [result.segmentId, result]))

  const nextSegments = new Map<string, Segment>()
  const nextBaseline: Record<string, SyncedSegmentSnapshot> = { ...input.baseline }
  const nextOutbox: PendingSegmentChange[] = []
  const conflicts: TranslationConflict[] = []
  const rollbacks: SyncPlan['rollbacks'] = []
  const pulled: SyncPlan['pulled'] = []
  const rejected: SyncItemResult[] = []
  const accepted: SyncItemResult[] = []
  /** 本轮已经处理过（推送过）的片段，跳过 remote-only 扫描。 */
  const handled = new Set<string>()

  // 1) 处理本地推送出去的片段
  for (const entry of input.outbox) {
    const segment = segmentMap.get(entry.segmentId)
    const result = resultMap.get(entry.segmentId)
    if (!segment) continue

    // 服务端没有给出该片段的结果（理论上不会发生）：原样留在队列。
    if (!result) {
      nextOutbox.push(entry)
      continue
    }

    if (result.status === 'accepted') {
      accepted.push(result)
      handled.add(entry.segmentId)
      // 本地改动与远端一致：保留本地版本，推进基线，条目出队。
      nextSegments.set(entry.segmentId, { ...segment, targetText: entry.localText, status: entry.localStatus })
      nextBaseline[entry.segmentId] = { segmentId: entry.segmentId, targetText: entry.localText, status: entry.localStatus }
      continue
    }

    if (result.status === 'rejected') {
      rejected.push(result)
      handled.add(entry.segmentId)
      // 远端拒绝：只把这个片段退回合并前的样子（同步前本地快照），其余片段不受影响。
      nextSegments.set(entry.segmentId, { ...segment, targetText: entry.localText, status: entry.localStatus })
      rollbacks.push({ segmentId: entry.segmentId, text: entry.localText, status: entry.localStatus })
      nextOutbox.push({
        ...entry,
        status: 'rejected',
        rejectReason: result.reason ?? '远端拒绝了该片段。',
        attempts: entry.attempts + 1,
        // 仍是旧基线，等修改后下次重试。
      })
      continue
    }

    // conflict：两边都动过，保留两版等人工挑选，本地内容不动，条目挂起。
    const remoteState = input.remote.find((state) => state.segmentId === entry.segmentId)
    if (remoteState) {
      conflicts.push(makeConflict(entry.segmentId, entry.localText, entry.localStatus, remoteState, 'both-modified', [], now))
    }
    nextOutbox.push(entry)
  }

  // 2) 扫描没有本地推送、但远端可能动过或需要处理冲突保护的片段
  for (const segment of input.segments) {
    if (handled.has(segment.id)) continue
    if (nextSegments.has(segment.id)) continue
    const remoteState = remoteMap.get(segment.id)
    const snapshot = input.baseline[segment.id]
    const localChanged = textStatusChanged(snapshot, segment.targetText, segment.status)
    const remoteChanged = !!remoteState && (!snapshot || snapshot.targetText !== remoteState.targetText || snapshot.status !== remoteState.status)

    // 本地还在编辑但没有进入本轮推送结果（例如冲突条目未选择前不推送）：保持本地。
    if (localChanged) {
      nextSegments.set(segment.id, segment)
      if (remoteState && remoteChanged && !conflicts.some((conflict) => conflict.segmentId === segment.id)) {
        conflicts.push(makeConflict(segment.id, segment.targetText, segment.status, remoteState, 'both-modified', [], now))
      }
      continue
    }

    if (remoteState && remoteChanged) {
      // 只有远端动过：照远端走。但占位符/链接不能在合并时被冲掉 —— 丢了就转人工。
      const baseText = snapshot?.targetText ?? segment.sourceText
      const dropped = dropsProtectedTokens(baseText, remoteState.targetText)
      if (dropped.length) {
        conflicts.push(makeConflict(segment.id, segment.targetText, segment.status, {
          ...remoteState,
          author: `${remoteState.author}（远端版本缺少 ${dropped.join('、')}）`,
        }, 'protected-tokens-dropped', dropped, now))
        nextSegments.set(segment.id, segment)
      } else {
        nextSegments.set(segment.id, { ...segment, targetText: remoteState.targetText, status: remoteState.status })
        nextBaseline[segment.id] = { segmentId: segment.id, targetText: remoteState.targetText, status: remoteState.status }
        pulled.push({ segmentId: segment.id, text: remoteState.targetText, status: remoteState.status })
      }
      continue
    }

    nextSegments.set(segment.id, segment)
  }

  // 保持原片段顺序
  const merged = input.segments.map((segment) => nextSegments.get(segment.id) ?? segment)

  return {
    segments: merged,
    nextBaseline,
    nextOutbox,
    conflicts,
    rollbacks,
    pulled,
    rejected,
    accepted,
  }
}

/**
 * 根据当前片段与基线对账本地队列：
 * 有差异就入队（重新编辑被拒条目即重新进入待推送），无差异就出队；
 * 尚未解决的冲突条目保持挂起，不参与自动推送。
 */
export const reconcileOutbox = (
  segments: Segment[],
  baseline: Record<string, SyncedSegmentSnapshot>,
  outbox: PendingSegmentChange[],
  conflictSegmentIds: Set<string>,
  now: number,
): PendingSegmentChange[] => {
  const existing = new Map(outbox.map((entry) => [entry.segmentId, entry]))
  const next: PendingSegmentChange[] = []
  for (const segment of segments) {
    const snapshot = baseline[segment.id]
    const changed = textStatusChanged(snapshot, segment.targetText, segment.status)
    const entry = existing.get(segment.id)

    // 冲突条目（两边都动过）在人工选择前一直挂起，不推送。
    if (conflictSegmentIds.has(segment.id)) {
      if (entry) {
        next.push({ ...entry, localText: segment.targetText, localStatus: segment.status })
      }
      continue
    }

    if (!changed) continue

    if (entry) {
      // 被拒条目一旦被修改，重置为待推送；内容未改则继续保留拒绝原因等重试。
      const editedAfterReject = entry.status === 'rejected' &&
        (entry.localText !== segment.targetText || entry.localStatus !== segment.status)
      next.push({
        ...entry,
        localText: segment.targetText,
        localStatus: segment.status,
        status: editedAfterReject ? 'pending' : entry.status,
        rejectReason: editedAfterReject ? undefined : entry.rejectReason,
        force: editedAfterReject ? false : entry.force,
        updatedAt: now,
      })
    } else {
      next.push({
        segmentId: segment.id,
        baseText: snapshot?.targetText ?? segment.targetText,
        baseStatus: snapshot?.status ?? segment.status,
        localText: segment.targetText,
        localStatus: segment.status,
        force: false,
        status: 'pending',
        attempts: 0,
        updatedAt: now,
      })
    }
  }
  return next
}

/** 从 seed 片段建立首次同步前的基线（各片段“远端已确认”的初始状态）。 */
export const baselineFromSegments = (segments: Segment[]): Record<string, SyncedSegmentSnapshot> =>
  Object.fromEntries(segments.map((segment) => [segment.id, {
    segmentId: segment.id,
    targetText: segment.targetText,
    status: segment.status,
  }]))
