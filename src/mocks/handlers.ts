import { http, HttpResponse } from 'msw'
import { analyzeDocument, extractProtected } from '@/lib/markdown'
import { seedConflicts, seedDocument, seedHistory } from '@/lib/seed'
import type { GlossaryTerm, OutboxEntry, Segment } from '@/lib/types'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

// In-memory remote state. The remote is the source of truth for the merge base;
// a colleague edit (see /api/simulate-remote-edit) makes it diverge from the
// local baseline so the three-way merge has something to reconcile.
let remoteSegments: Segment[] = clone(seedDocument.segments)
let remoteRevision = 0
let transientRejected = false

const colleagueEdits: Record<string, string> = {
  'seg-08': '如果控制器无法连接 API 服务器，请先检查网络策略，然后重启 Pod。',
  'seg-02': '本指南说明如何将 {{project_name}} {{version}} 版部署到 Kubernetes 集群。',
}

export const handlers = [
  http.get('/api/document', () => HttpResponse.json({ ...clone(seedDocument), segments: clone(remoteSegments) })),
  http.get('/api/history', () => HttpResponse.json(clone(seedHistory))),
  http.get('/api/conflicts', () => HttpResponse.json(clone(seedConflicts))),

  http.post('/api/check', async ({ request }) => {
    const body = await request.json() as { segments: Segment[]; glossary: GlossaryTerm[] }
    await new Promise((resolve) => setTimeout(resolve, 320))
    return HttpResponse.json({ checkedAt: Date.now(), issues: analyzeDocument(body.segments, body.glossary) })
  }),

  http.post('/api/draft', async ({ request }) => {
    const body = await request.json() as { documentId: string; segments: Segment[]; discussions: unknown[] }
    await new Promise((resolve) => setTimeout(resolve, 240))
    return HttpResponse.json({ saved: true, documentId: body.documentId, segmentCount: body.segments.length, savedAt: Date.now() })
  }),

  http.post('/api/review', async ({ request }) => {
    const body = await request.json() as { action: string; segmentIds: string[]; reason?: string }
    await new Promise((resolve) => setTimeout(resolve, 280))
    return HttpResponse.json({ accepted: true, ...body, reviewedAt: Date.now() })
  }),

  // A colleague edits the remote document. Used to demonstrate reconciling a
  // remote-only change (or a both-edited conflict when combined with an offline
  // local edit).
  http.post('/api/simulate-remote-edit', async () => {
    for (const [segmentId, text] of Object.entries(colleagueEdits)) {
      const segment = remoteSegments.find((item) => item.id === segmentId)
      if (segment) segment.targetText = text
    }
    remoteRevision += 1
    await new Promise((resolve) => setTimeout(resolve, 200))
    return HttpResponse.json({ ...clone(seedDocument), segments: clone(remoteSegments), revision: remoteRevision })
  }),

  // Push offline edits to the remote. Each segment is handled independently:
  // accepted segments advance the remote revision, rejected ones are returned
  // with a reason so the client can roll back just that segment and keep it in
  // the local outbox for retry.
  http.post('/api/sync', async ({ request }) => {
    const body = await request.json() as { documentId: string; entries: OutboxEntry[] }
    await new Promise((resolve) => setTimeout(resolve, 420))
    const results = body.entries.map((entry) => {
      const remote = remoteSegments.find((segment) => segment.id === entry.segmentId)
      if (!remote) {
        return { segmentId: entry.segmentId, status: 'rejected' as const, reason: 'missing-segment', message: '远端不存在该片段。' }
      }
      // Stale base: a colleague moved this segment after the client's last sync.
      if (entry.baseText !== remote.targetText) {
        return {
          segmentId: entry.segmentId,
          status: 'conflict' as const,
          remoteText: remote.targetText,
          remoteAuthor: '远端协作者 · Alex',
          reason: 'stale-base',
          message: '该片段在你离线期间被同事修改。',
        }
      }
      // Validation: protected tokens from the source must survive the merge.
      const sourceTokens = extractProtected(remote.sourceText)
      const missingTokens = sourceTokens.filter((token) => !entry.localText.includes(token))
      if (missingTokens.length) {
        return {
          segmentId: entry.segmentId,
          status: 'rejected' as const,
          reason: 'missing-token',
          message: `译文缺少受保护标记：${missingTokens.join('、')}`,
        }
      }
      // Simulated transient failure on the first sync attempt: the segment is
      // rejected so the client rolls it back and retries on the next sync.
      if (!transientRejected) {
        transientRejected = true
        return {
          segmentId: entry.segmentId,
          status: 'rejected' as const,
          reason: 'transient',
          message: '远端同步服务暂时不可用，该片段未合并，请重试。',
        }
      }
      remote.targetText = entry.localText
      remoteRevision += 1
      return { segmentId: entry.segmentId, status: 'accepted' as const, remoteText: entry.localText, revision: remoteRevision }
    })
    return HttpResponse.json({ syncedAt: Date.now(), results })
  }),
]
