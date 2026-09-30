import { http, HttpResponse } from 'msw'
import { analyzeDocument, extractProtected } from '@/lib/markdown'
import { seedConflicts, seedDocument, seedHistory, seedRemoteSegments } from '@/lib/seed'
import type { GlossaryTerm, RemoteSegmentState, Segment, SyncChangeRequest, SyncResponse } from '@/lib/types'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

// 可写的“远端文档”状态：同步成功的片段会真正落到这里，模拟同事之后能看到。
const remoteSegments: RemoteSegmentState[] = clone(seedRemoteSegments)
let revision = 3

/** 工作台通过该请求头模拟断网（flight mode）：所有接口直接失败。 */
const offlineResponse = () => HttpResponse.json({ error: 'offline', message: '当前处于离线状态，请求未发出。' }, { status: 503 })
const isOffline = (request: Request) => request.headers.get('X-Simulate-Offline') === '1'

export const handlers = [
  http.get('/api/document', ({ request }) => {
    if (isOffline(request)) return offlineResponse()
    const document = clone(seedDocument)
    // 以远端最新片段内容为准，模拟同事改过的远端文档。
    document.segments = document.segments.map((segment) => {
      const remote = remoteSegments.find((item) => item.segmentId === segment.id)
      return remote ? { ...segment, targetText: remote.targetText, status: remote.status } : segment
    })
    return HttpResponse.json(document)
  }),
  http.get('/api/history', ({ request }) => {
    if (isOffline(request)) return offlineResponse()
    return HttpResponse.json(clone(seedHistory))
  }),
  http.get('/api/conflicts', ({ request }) => {
    if (isOffline(request)) return offlineResponse()
    return HttpResponse.json(clone(seedConflicts))
  }),
  http.post('/api/check', async ({ request }) => {
    if (isOffline(request)) return offlineResponse()
    const body = await request.json() as { segments: Segment[]; glossary: GlossaryTerm[] }
    await new Promise((resolve) => setTimeout(resolve, 320))
    return HttpResponse.json({ checkedAt: Date.now(), issues: analyzeDocument(body.segments, body.glossary) })
  }),
  http.post('/api/draft', async ({ request }) => {
    if (isOffline(request)) return offlineResponse()
    const body = await request.json() as { documentId: string; segments: Segment[]; discussions: unknown[] }
    await new Promise((resolve) => setTimeout(resolve, 240))
    return HttpResponse.json({ saved: true, documentId: body.documentId, segmentCount: body.segments.length, savedAt: Date.now() })
  }),
  http.post('/api/review', async ({ request }) => {
    if (isOffline(request)) return offlineResponse()
    const body = await request.json() as { action: string; segmentIds: string[]; reason?: string }
    await new Promise((resolve) => setTimeout(resolve, 280))
    return HttpResponse.json({ accepted: true, ...body, reviewedAt: Date.now() })
  }),
  http.post('/api/sync', async ({ request }) => {
    if (isOffline(request)) return offlineResponse()
    const body = await request.json() as { documentId: string; changes: SyncChangeRequest[] }
    await new Promise((resolve) => setTimeout(resolve, 420))

    const results = body.changes.map((change) => {
      const remote = remoteSegments.find((item) => item.segmentId === change.segmentId)
      if (!remote) {
        return { segmentId: change.segmentId, status: 'rejected' as const, reason: '远端不存在该片段，拒绝同步。' }
      }

      // 服务端兜底保护：文本改动不得冲掉基线里的占位符和链接。
      if (change.localText !== change.baseText) {
        const localTokens = new Set(extractProtected(change.localText))
        const dropped = extractProtected(change.baseText).filter((token) => !localTokens.has(token))
        if (dropped.length) {
          return {
            segmentId: change.segmentId,
            status: 'rejected' as const,
            reason: `远端校验未通过：占位符或链接缺失（${dropped.join('、')}），请补回后重试。`,
          }
        }
      }

      // 双方相对基线都改过且未声明强推 → 冲突，留两版给译者挑。
      const remoteChanged = remote.targetText !== change.baseText || remote.status !== change.baseStatus
      const localChanged = change.localText !== change.baseText || change.localStatus !== change.baseStatus
      if (remoteChanged && localChanged && !change.force) {
        return {
          segmentId: change.segmentId,
          status: 'conflict' as const,
          reason: '本地与远端都修改了该片段。',
          remoteText: remote.targetText,
          remoteStatus: remote.status,
          remoteAuthor: remote.author,
        }
      }

      // 接受：远端落盘为本地版本。
      remote.targetText = change.localText
      remote.status = change.localStatus
      remote.author = '当前用户（已同步）'
      remote.updatedAt = Date.now()
      return {
        segmentId: change.segmentId,
        status: 'accepted' as const,
        remoteText: change.localText,
        remoteStatus: change.localStatus,
        remoteAuthor: remote.author,
      }
    })

    if (results.some((result) => result.status === 'accepted')) revision += 1

    const response: SyncResponse = {
      syncedAt: Date.now(),
      revision,
      results,
      remote: clone(remoteSegments),
    }
    return HttpResponse.json(response)
  }),
]
