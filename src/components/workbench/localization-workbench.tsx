'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  AlertCircle, ArrowDown, ArrowUp, BookOpen, Check, CheckCheck, ChevronRight, CircleAlert,
  Cloud, CloudOff, CloudUpload, Code2, Download, FileText, GitCompare, History, Import,
  Languages, Link2, Loader2, MessageSquare, RotateCcw, RotateCw, Save, Search,
  Send, ShieldCheck, Sparkles, Undo2, UndoDot, Variable, Wifi, WifiOff, X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { analyzeDocument, parseMarkdown, renderTargetMarkdown } from '@/lib/markdown'
import { baselineFromSegments, planSyncMerge, reconcileOutbox } from '@/lib/sync'
import {
  seedConflicts, seedDiscussions, seedDocument, seedGlossary, seedHistory, seedSegments,
  seedSyncedBaseline,
} from '@/lib/seed'
import type {
  Discussion, GlossaryTerm, HistoryEntry, PendingSegmentChange, Segment, SegmentStatus,
  SyncLog, SyncResponse, TranslationConflict, TranslationIssue,
} from '@/lib/types'
import { cn } from '@/lib/utils'

const DRAFT_KEY = 'sologsb-1003-localization-draft-v2'
const LEGACY_DRAFT_KEY = 'sologsb-1003-localization-draft-v1'
const kindIcon = { heading: <FileText className="h-3.5 w-3.5" />, paragraph: <FileText className="h-3.5 w-3.5" />, code: <Code2 className="h-3.5 w-3.5" />, link: <Link2 className="h-3.5 w-3.5" />, variable: <Variable className="h-3.5 w-3.5" /> }
const kindLabel: Record<Segment['kind'], string> = { heading: '标题', paragraph: '段落', code: '代码块', link: '链接', variable: '占位符' }
const statusLabel: Record<SegmentStatus, string> = { draft: '草稿', 'needs-work': '待处理', confirmed: '已确认', returned: '已退回' }
const statusClass: Record<SegmentStatus, string> = {
  draft: 'bg-slate-100 text-slate-700', 'needs-work': 'bg-amber-100 text-amber-800',
  confirmed: 'bg-emerald-100 text-emerald-800', returned: 'bg-red-100 text-red-800',
}
const actionLabel: Record<HistoryEntry['action'], string> = {
  edit: '编辑', confirm: '确认', return: '退回', 'resolve-conflict': '解决冲突', import: '导入', discussion: '讨论', sync: '同步合并',
}
const issueLabel: Record<TranslationIssue['type'], string> = {
  'missing-translation': '漏译', 'missing-variable': '变量缺失', 'link-mismatch': '链接不一致', glossary: '术语不一致', 'code-format': '代码格式',
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

interface EditorSnapshot {
  segments: Segment[]
  discussions: Discussion[]
}

interface SyncNotice {
  id: number
  tone: 'success' | 'warning' | 'error' | 'info'
  text: string
}

const baselineToMap = (snapshots: { segmentId: string; targetText: string; status: SegmentStatus }[]) =>
  Object.fromEntries(snapshots.map((snapshot) => [snapshot.segmentId, snapshot]))
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

export function LocalizationWorkbench() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [segments, setSegments] = useState<Segment[]>(seedSegments)
  const [glossary, setGlossary] = useState<GlossaryTerm[]>(seedGlossary)
  const [discussions, setDiscussions] = useState<Discussion[]>(seedDiscussions)
  const [history, setHistory] = useState<HistoryEntry[]>(seedHistory)
  const [conflicts, setConflicts] = useState<TranslationConflict[]>(seedConflicts)
  const [checkedIssues, setCheckedIssues] = useState<TranslationIssue[] | null>(null)
  const [selectedSegmentId, setSelectedSegmentId] = useState('seg-05')
  const [mode, setMode] = useState<'translate' | 'review'>('translate')
  const [filter, setFilter] = useState<'all' | 'issues' | 'untranslated' | 'confirmed'>('all')
  const [glossarySearch, setGlossarySearch] = useState('')
  const [discussionDraft, setDiscussionDraft] = useState('')
  const [selectedForReturn, setSelectedForReturn] = useState<Set<string>>(new Set())
  const [returnReason, setReturnReason] = useState('请根据术语表修改后重新提交。')
  const [dirty, setDirty] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [past, setPast] = useState<EditorSnapshot[]>([])
  const [future, setFuture] = useState<EditorSnapshot[]>([])

  // —— 离线暂存 / 对账合并状态 ——
  const [browserOnline, setBrowserOnline] = useState(true)
  const [simulateOffline, setSimulateOffline] = useState(false)
  const effectiveOnline = browserOnline && !simulateOffline
  const [syncing, setSyncing] = useState(false)
  const syncingRef = useRef(false)
  const [baseline, setBaseline] = useState<Record<string, { segmentId: string; targetText: string; status: SegmentStatus }>>(() => baselineToMap(seedSyncedBaseline))
  const [outbox, setOutbox] = useState<PendingSegmentChange[]>([])
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([])
  const [notice, setNotice] = useState<SyncNotice | null>(null)
  const [flushTick, setFlushTick] = useState(0)
  const initialPullDone = useRef(false)

  // 让异步流程始终读到最新值
  const stateRef = useRef({ segments, baseline, outbox, conflicts, glossary, effectiveOnline })
  stateRef.current = { segments, baseline, outbox, conflicts, glossary, effectiveOnline }

  const documentQuery = useQuery({
    queryKey: ['localization-document'],
    queryFn: async () => {
      const response = await fetch('/api/document', { headers: syncHeaders() })
      if (!response.ok) throw new Error('document request failed')
      return response.json()
    },
    initialData: seedDocument,
  })
  const historyQuery = useQuery({
    queryKey: ['localization-history'],
    queryFn: async () => {
      const response = await fetch('/api/history', { headers: syncHeaders() })
      if (!response.ok) throw new Error('history request failed')
      return response.json() as Promise<HistoryEntry[]>
    },
    initialData: seedHistory,
  })

  const checkMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/check', {
        method: 'POST', headers: syncHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ segments: stateRef.current.segments, glossary: stateRef.current.glossary }),
      })
      if (!response.ok) throw new Error('check failed')
      return response.json() as Promise<{ checkedAt: number; issues: TranslationIssue[] }>
    },
    onSuccess: (data) => {
      setCheckedIssues(data.issues)
      setFilter('issues')
    },
  })
  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/draft', {
        method: 'POST', headers: syncHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ documentId: seedDocument.id, segments: stateRef.current.segments, discussions }),
      })
      if (!response.ok) throw new Error('save failed')
      return response.json()
    },
    onSuccess: () => {
      setDirty(false)
      pushNotice('success', '草稿已保存到远端。')
    },
    onError: () => pushNotice('error', '远端保存失败，改动仍安全地留在本地。'),
  })
  const reviewMutation = useMutation({
    mutationFn: async (payload: { action: string; segmentIds: string[]; reason?: string }) => {
      const response = await fetch('/api/review', {
        method: 'POST', headers: syncHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error('review failed')
      return response.json()
    },
  })

  function syncHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return simulateOffline ? { 'X-Simulate-Offline': '1', ...extra } : extra
  }
  const pushNotice = useCallback((tone: SyncNotice['tone'], text: string) => {
    setNotice({ id: Date.now(), tone, text })
  }, [])

  const liveIssues = useMemo(() => analyzeDocument(segments, glossary), [segments, glossary])
  const issues = checkedIssues ?? liveIssues
  const issueMap = useMemo(() => issues.reduce<Record<string, TranslationIssue[]>>((map, issue) => {
    map[issue.segmentId] = [...(map[issue.segmentId] ?? []), issue]
    return map
  }, {}), [issues])
  const issueSegmentIds = useMemo(() => new Set(issues.map((issue) => issue.segmentId)), [issues])
  const filteredSegments = useMemo(() => segments.filter((segment) => {
    if (filter === 'issues') return issueSegmentIds.has(segment.id)
    if (filter === 'untranslated') return !segment.targetText.trim()
    if (filter === 'confirmed') return segment.status === 'confirmed'
    return true
  }), [filter, issueSegmentIds, segments])
  const selectedSegment = segments.find((segment) => segment.id === selectedSegmentId) ?? segments[0]
  const confirmedCount = segments.filter((segment) => segment.status === 'confirmed').length
  const translatedCount = segments.filter((segment) => segment.targetText.trim()).length
  const progress = segments.length ? Math.round((confirmedCount / segments.length) * 100) : 0
  const filteredGlossary = glossary.filter((term) => `${term.source} ${term.target}`.toLowerCase().includes(glossarySearch.toLowerCase()))
  const selectedDiscussions = discussions.filter((discussion) => discussion.segmentId === selectedSegment?.id)

  const conflictSegmentIds = useMemo(() => new Set(conflicts.map((conflict) => conflict.segmentId)), [conflicts])
  const outboxMap = useMemo(() => new Map(outbox.map((entry) => [entry.segmentId, entry])), [outbox])
  const pendingCount = outbox.filter((entry) => entry.status === 'pending' && !conflictSegmentIds.has(entry.segmentId)).length
  const retryCount = outbox.filter((entry) => entry.status === 'rejected').length
  const sendableCount = pendingCount + retryCount

  // —— 启动时恢复本地草稿 / 基线 / 同步队列 ——
  useEffect(() => {
    if (hydrated) return
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      const legacy = raw ? null : localStorage.getItem(LEGACY_DRAFT_KEY)
      const draft = raw ? JSON.parse(raw) as Record<string, unknown> : legacy ? JSON.parse(legacy) as Record<string, unknown> : null
      if (draft && Array.isArray(draft.segments) && (draft.segments as Segment[]).length) {
        setSegments(draft.segments as Segment[])
        setDiscussions((draft.discussions as Discussion[]) ?? seedDiscussions)
        setGlossary((draft.glossary as GlossaryTerm[]) ?? seedGlossary)
        setHistory((draft.history as HistoryEntry[]) ?? seedHistory)
        setConflicts((draft.conflicts as TranslationConflict[]) ?? [])
        setSyncLogs((draft.syncLogs as SyncLog[]) ?? [])
        const restoredBaseline = (draft.baseline as Record<string, { segmentId: string; targetText: string; status: SegmentStatus }>)
          ?? baselineFromSegments(draft.segments as Segment[])
        setBaseline(restoredBaseline)
        setOutbox((draft.outbox as PendingSegmentChange[]) ?? (legacy ? [] : reconcileOutbox(seedSegments, baselineToMap(seedSyncedBaseline), [], new Set(), Date.now())))
      } else {
        const initialBaseline = baselineToMap(seedSyncedBaseline)
        setBaseline(initialBaseline)
        setOutbox(reconcileOutbox(seedSegments, initialBaseline, [], new Set(), Date.now()))
      }
    } catch { /* 从 seed 开始 */ }
    setHydrated(true)
  }, [hydrated])

  // —— 草稿（含同步队列、基线、冲突、日志）实时写入本地，断网/刷新都不丢 ——
  useEffect(() => {
    if (!hydrated) return
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ segments, discussions, glossary, history, baseline, outbox, conflicts, syncLogs }))
    } catch { /* storage may be unavailable */ }
  }, [baseline, conflicts, discussions, glossary, history, hydrated, outbox, segments, syncLogs])

  // —— 本地改动与基线对账：有差异即入队等待同步，差异消失即出队 ——
  useEffect(() => {
    if (!hydrated || syncing) return
    setOutbox((current) => reconcileOutbox(segments, baseline, current, conflictSegmentIds, Date.now()))
  }, [segments, baseline, hydrated, syncing, conflictSegmentIds])

  // —— 监听真实网络状态 ——
  useEffect(() => {
    const update = () => setBrowserOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // —— 同步主流程：把队列推给远端，逐片段对账合并 ——
  const runSync = useCallback(async (): Promise<void> => {
    const { segments: currentSegments, baseline: currentBaseline, outbox: currentOutbox, conflicts: currentConflicts } = stateRef.current
    if (!stateRef.current.effectiveOnline) {
      setSyncLogs((logs) => [{ id: uid('synclog'), at: Date.now(), connected: false, accepted: 0, rejected: 0, conflicts: 0, pulled: 0, message: '断网中：改动已攒在本地，恢复网络后自动对账。' }, ...logs].slice(0, 30))
      pushNotice('warning', '当前断网，改动已攒在本地；网络恢复后会自动按片段对账合并。')
      return
    }
    if (syncingRef.current) return
    syncingRef.current = true
    setSyncing(true)

    const activeConflictIds = new Set(currentConflicts.map((conflict) => conflict.segmentId))
    // 冲突未选择版本的条目暂不推送；强推（保留本地）的条目可以推送。
    const changes = currentOutbox
      .filter((entry) => entry.force || !activeConflictIds.has(entry.segmentId))
      .map((entry) => ({
        segmentId: entry.segmentId,
        baseText: entry.baseText,
        baseStatus: entry.baseStatus,
        localText: entry.localText,
        localStatus: entry.localStatus,
        force: entry.force,
      }))

    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: syncHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ documentId: seedDocument.id, changes }),
      })
      if (!response.ok) throw new Error(`sync failed: ${response.status}`)
      const data = await response.json() as SyncResponse

      const plan = planSyncMerge({
        segments: currentSegments,
        baseline: currentBaseline,
        outbox: currentOutbox,
        results: data.results,
        remote: data.remote,
      })

      const segmentsChanged = plan.segments.some((segment, index) => {
        const before = currentSegments[index]
        return before && (before.targetText !== segment.targetText || before.status !== segment.status)
      })
      if (segmentsChanged) {
        setPast((current) => [...current.slice(-49), { segments: clone(currentSegments), discussions: clone(discussions) }])
        setFuture([])
      }
      setSegments(plan.segments)
      setBaseline(plan.nextBaseline)
      setOutbox(plan.nextOutbox)
      setConflicts(plan.conflicts)
      setCheckedIssues(null)

      // 拉取到的远端改动记入历史
      for (const pulled of plan.pulled) {
        const before = currentSegments.find((segment) => segment.id === pulled.segmentId)
        const remoteState = data.remote.find((state) => state.segmentId === pulled.segmentId)
        setHistory((current) => [{ id: uid('history'), segmentId: pulled.segmentId, author: remoteState?.author ?? '远端协作者', action: 'sync', before: before?.targetText ?? '', after: pulled.text, createdAt: Date.now() }, ...current])
      }
      // 被远端拒绝的片段单独留痕（片段已退回合并前样子）
      for (const rejected of plan.rejected) {
        setHistory((current) => [{ id: uid('history'), segmentId: rejected.segmentId, author: '远端服务', action: 'sync', before: '', after: `同步被拒，已退回：${rejected.reason ?? ''}`, createdAt: Date.now() }, ...current])
      }

      const parts: string[] = []
      if (plan.accepted.length) parts.push(`${plan.accepted.length} 个片段已同步`)
      if (plan.pulled.length) parts.push(`拉取同事改动 ${plan.pulled.length} 个片段`)
      const bothModified = plan.conflicts.filter((conflict) => conflict.reason !== 'protected-tokens-dropped').length
      const protectedBlocked = plan.conflicts.length - bothModified
      if (bothModified) parts.push(`${bothModified} 个片段两边都动过，留了两版待挑选`)
      if (protectedBlocked) parts.push(`${protectedBlocked} 个远端片段会冲掉占位符/链接，已拦下待处理`)
      if (plan.rejected.length) parts.push(`${plan.rejected.length} 个片段被远端拒绝、已退回`)
      const message = parts.length ? parts.join('；') : '所有片段均与远端一致。'
      setSyncLogs((logs) => [{
        id: uid('synclog'), at: data.syncedAt, connected: true,
        accepted: plan.accepted.length, rejected: plan.rejected.length,
        conflicts: plan.conflicts.length, pulled: plan.pulled.length, message,
      }, ...logs].slice(0, 30))

      if (plan.rejected.length) pushNotice('error', message)
      else if (plan.conflicts.length) pushNotice('warning', message)
      else pushNotice('success', message)
    } catch {
      setSyncLogs((logs) => [{ id: uid('synclog'), at: Date.now(), connected: false, accepted: 0, rejected: 0, conflicts: 0, pulled: 0, message: '同步请求失败：改动安全留在本地，可稍后重试。' }, ...logs].slice(0, 30))
      pushNotice('error', '同步失败（网络不可用），改动仍攒在本地，恢复后可重试。')
    } finally {
      syncingRef.current = false
      setSyncing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discussions, pushNotice])

  // —— 启动后首次拉取远端做一次对账；冲突卡片里选完版本后也会触发 ——
  useEffect(() => {
    if (!hydrated || flushTick < 0) return
    if (flushTick === 0) {
      if (initialPullDone.current) return
      initialPullDone.current = true
      const timer = setTimeout(() => { if (stateRef.current.effectiveOnline) void runSync() }, 700)
      return () => clearTimeout(timer)
    }
    void runSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, flushTick])

  // —— 网络恢复后自动对账合并 ——
  const wasOnline = useRef(effectiveOnline)
  useEffect(() => {
    if (effectiveOnline && !wasOnline.current) {
      pushNotice('info', '网络已恢复，正在与远端对账合并…')
      void runSync()
    }
    wasOnline.current = effectiveOnline
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveOnline])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])

  const snapshot = (): EditorSnapshot => ({ segments: clone(segments), discussions: clone(discussions) })
  const pushHistoryEntry = (segmentId: string, action: HistoryEntry['action'], before: string, after: string, author = '当前用户') => {
    setHistory((current) => [ { id: uid('history'), segmentId, author, action, before, after, createdAt: Date.now() }, ...current])
  }
  const replaceState = (next: EditorSnapshot, markDirty = true) => {
    setPast((current) => [...current.slice(-49), snapshot()])
    setFuture([])
    setSegments(next.segments)
    setDiscussions(next.discussions)
    setCheckedIssues(null)
    if (markDirty) setDirty(true)
  }
  const updateTarget = (segment: Segment, targetText: string) => {
    const next = segments.map((item) => item.id === segment.id ? { ...item, targetText, status: item.status === 'confirmed' ? 'draft' as const : item.status } : item)
    replaceState({ segments: next, discussions: clone(discussions) })
  }
  const updateStatus = (segmentId: string, status: SegmentStatus, action: HistoryEntry['action'] = status === 'confirmed' ? 'confirm' : 'return') => {
    const segment = segments.find((item) => item.id === segmentId)
    if (!segment) return
    const next = segments.map((item) => item.id === segmentId ? { ...item, status } : item)
    replaceState({ segments: next, discussions: clone(discussions) })
    pushHistoryEntry(segmentId, action, segment.targetText, segment.targetText)
    setSelectedForReturn((current) => { const copy = new Set(current); copy.delete(segmentId); return copy })
  }
  const undo = () => {
    const previous = past.at(-1)
    if (!previous) return
    setFuture((current) => [snapshot(), ...current])
    setPast((current) => current.slice(0, -1))
    setSegments(previous.segments)
    setDiscussions(previous.discussions)
    setCheckedIssues(null)
    setDirty(true)
  }
  const redo = () => {
    const next = future[0]
    if (!next) return
    setPast((current) => [...current, snapshot()])
    setFuture((current) => current.slice(1))
    setSegments(next.segments)
    setDiscussions(next.discussions)
    setCheckedIssues(null)
    setDirty(true)
  }
  const selectAndScroll = (segmentId: string) => {
    setSelectedSegmentId(segmentId)
    requestAnimationFrame(() => document.getElementById(`segment-${segmentId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }
  const nextIssue = (direction: 1 | -1 = 1) => {
    const ids = Array.from(new Set(issues.map((issue) => issue.segmentId)))
    if (!ids.length) return
    const index = Math.max(0, ids.indexOf(selectedSegmentId))
    const nextIndex = direction > 0 ? (index + 1) % ids.length : (index - 1 + ids.length) % ids.length
    selectAndScroll(ids[nextIndex])
  }
  const addDiscussion = () => {
    if (!selectedSegment || !discussionDraft.trim()) return
    const nextDiscussion: Discussion = { id: `discussion-${Date.now()}`, segmentId: selectedSegment.id, author: '译者 · 当前用户', body: discussionDraft.trim(), resolved: false, createdAt: Date.now() }
    replaceState({ segments: clone(segments), discussions: [nextDiscussion, ...discussions] })
    pushHistoryEntry(selectedSegment.id, 'discussion', '', nextDiscussion.body)
    setDiscussionDraft('')
  }
  const bulkReturn = () => {
    if (!selectedForReturn.size) return
    const ids = Array.from(selectedForReturn)
    const next = segments.map((segment) => ids.includes(segment.id) ? { ...segment, status: 'returned' as const } : segment)
    replaceState({ segments: next, discussions: clone(discussions) })
    ids.forEach((id) => pushHistoryEntry(id, 'return', returnReason, `退回原因：${returnReason}`, '审校 · 当前用户'))
    if (effectiveOnline) void reviewMutation.mutateAsync({ action: 'bulk-return', segmentIds: ids, reason: returnReason })
    setSelectedForReturn(new Set())
  }

  // —— 冲突处理：保留本地（强推同步） / 采用远端（补回占位符后直接落盘） ——
  const keepLocalVersion = (conflict: TranslationConflict) => {
    const current = segments.find((segment) => segment.id === conflict.segmentId)
    const localText = current?.targetText ?? conflict.localText
    const localStatus = current?.status ?? conflict.localStatus ?? 'draft'
    setOutbox((currentOutbox) => {
      const others = currentOutbox.filter((entry) => entry.segmentId !== conflict.segmentId)
      const existing = currentOutbox.find((entry) => entry.segmentId === conflict.segmentId)
      const snapshotEntry = baseline[conflict.segmentId]
      const entry: PendingSegmentChange = {
        segmentId: conflict.segmentId,
        baseText: snapshotEntry?.targetText ?? conflict.remoteText,
        baseStatus: snapshotEntry?.status ?? localStatus,
        localText,
        localStatus,
        force: true,
        status: 'pending',
        rejectReason: undefined,
        attempts: (existing?.attempts ?? 0) + 1,
        updatedAt: Date.now(),
      }
      return [...others, entry]
    })
    setConflicts((currentConflicts) => currentConflicts.filter((item) => item.id !== conflict.id))
    pushHistoryEntry(conflict.segmentId, 'resolve-conflict', conflict.remoteText, localText, '保留本地')
    setFlushTick((tick) => tick + 1)
  }

  const adoptRemoteVersion = (conflict: TranslationConflict) => {
    const remoteStatus = conflict.remoteStatus ?? 'draft'
    const restoreTokens = conflict.protectTokens ?? []
    const mergedText = restoreTokens.length
      ? `${conflict.remoteText.trimEnd()}\n\n${restoreTokens.join(' ')}`
      : conflict.remoteText
    setSegments((current) => current.map((segment) =>
      segment.id === conflict.segmentId ? { ...segment, targetText: mergedText, status: remoteStatus } : segment))
    // 基线记补回标记后的版本：后续编辑仍受占位符/链接保护，且不会产生多余待同步条目。
    setBaseline((current) => ({ ...current, [conflict.segmentId]: { segmentId: conflict.segmentId, targetText: mergedText, status: remoteStatus } }))
    setOutbox((current) => current.filter((entry) => entry.segmentId !== conflict.segmentId))
    setConflicts((current) => current.filter((item) => item.id !== conflict.id))
    setCheckedIssues(null)
    pushHistoryEntry(conflict.segmentId, 'resolve-conflict', conflict.localText, mergedText, conflict.remoteAuthor)
    if (restoreTokens.length) {
      pushNotice('warning', `已采用远端版本，并把合并时不能丢失的 ${restoreTokens.join('、')} 补回文末，请调整到合适位置。`)
    } else {
      pushNotice('success', '已采用远端版本，该片段与远端一致。')
    }
  }

  const importMarkdown = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const imported = parseMarkdown(await file.text())
    if (!imported.length) return
    replaceState({ segments: imported, discussions: [] })
    setBaseline(baselineFromSegments(imported))
    setOutbox([])
    setConflicts([])
    pushHistoryEntry(imported[0].id, 'import', '', file.name)
    setSelectedSegmentId(imported[0].id)
    event.target.value = ''
  }
  const exportMarkdown = () => {
    const blob = new Blob([renderTargetMarkdown(segments)], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = documentQuery.data.sourceFile.replace(/\.md$/, '.zh-CN.md')
    anchor.click()
    URL.revokeObjectURL(url)
  }
  const toggleReturnSelection = (segmentId: string) => {
    setSelectedForReturn((current) => {
      const next = new Set(current)
      next.has(segmentId) ? next.delete(segmentId) : next.add(segmentId)
      return next
    })
  }
  const handleSave = () => {
    if (!effectiveOnline) {
      setDirty(false)
      pushNotice('info', '断网期间已暂存到浏览器本地，联网后随同步一起提交。')
      return
    }
    saveMutation.mutate()
  }
  const handleCheck = () => {
    if (!effectiveOnline) {
      setCheckedIssues(analyzeDocument(stateRef.current.segments, stateRef.current.glossary))
      setFilter('issues')
      pushNotice('info', '断网期间使用本地术语表检查，结果与在线时一致。')
      return
    }
    checkMutation.mutate()
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); event.shiftKey ? redo() : undo(); return
      }
      if (editing) return
      if (event.key.toLowerCase() === 'j') { event.preventDefault(); nextIssue(1) }
      if (event.key.toLowerCase() === 'k') { event.preventDefault(); nextIssue(-1) }
      if (event.key.toLowerCase() === 'c' && selectedSegment && mode === 'review') updateStatus(selectedSegment.id, 'confirmed')
      if (event.key.toLowerCase() === 'r' && selectedSegment && mode === 'review') updateStatus(selectedSegment.id, 'returned')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const noticeToneClass: Record<SyncNotice['tone'], string> = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
    error: 'border-red-200 bg-red-50 text-red-800',
    info: 'border-blue-200 bg-blue-50 text-blue-800',
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,#e8f1ff_0,transparent_32%)] pb-24">
      <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-slate-950/95 text-white shadow-xl backdrop-blur">
        <div className="mx-auto flex max-w-[1800px] items-center gap-5 px-4 py-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-blue-400/30 bg-blue-500/15 text-blue-300"><Languages className="h-5 w-5" /></div>
            <div className="min-w-0"><h1 className="truncate font-semibold tracking-tight">开源文档本地化工作台</h1><p className="truncate text-[11px] text-slate-400">{documentQuery.data.sourceFile} · {documentQuery.data.title}</p></div>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <Badge className={cn('border-0', effectiveOnline ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/20 text-red-200')}>{effectiveOnline ? <Cloud className="mr-1 h-3 w-3" /> : <CloudOff className="mr-1 h-3 w-3" />}{effectiveOnline ? '网络在线' : '已断网 · 本地暂存'}</Badge>
            {sendableCount > 0 && <Badge className="border-0 bg-amber-500/15 text-amber-300"><CloudUpload className="mr-1 h-3 w-3" />{sendableCount} 条待同步</Badge>}
            {retryCount > 0 && <Badge className="border-0 bg-red-500/20 text-red-200">{retryCount} 条被拒待改</Badge>}
            <button onClick={() => setSimulateOffline((value) => !value)} className="flex items-center gap-1 rounded-full border border-slate-600 bg-slate-800 px-2.5 py-0.5 text-[11px] text-slate-200 transition hover:bg-slate-700" title="模拟飞行途中断网 / 恢复网络">
              {simulateOffline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}{simulateOffline ? '恢复网络' : '模拟断网'}
            </button>
          </div>
          <div className="header-actions ml-auto flex items-center gap-2">
            <Tabs value={mode} onValueChange={(value) => setMode(value as 'translate' | 'review')}><TabsList className="bg-slate-800"><TabsTrigger value="translate" className="text-slate-300 data-[state=active]:bg-blue-600 data-[state=active]:text-white">翻译</TabsTrigger><TabsTrigger value="review" className="text-slate-300 data-[state=active]:bg-blue-600 data-[state=active]:text-white">审校</TabsTrigger></TabsList></Tabs>
            <Button variant="outline" size="sm" className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 hover:text-white" onClick={undo} disabled={!past.length}><Undo2 className="h-4 w-4" />撤销</Button>
            <Button variant="outline" size="sm" className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 hover:text-white" onClick={redo} disabled={!future.length}><RotateCw className="h-4 w-4" />重做</Button>
            <input ref={fileInput} type="file" accept=".md,.markdown,text/markdown" className="hidden" onChange={(event) => void importMarkdown(event)} />
            <Button variant="outline" size="sm" className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 hover:text-white" onClick={() => fileInput.current?.click()}><Import className="h-4 w-4" />导入</Button>
            <Button size="sm" onClick={() => void runSync()} disabled={syncing || !effectiveOnline} className="bg-violet-600 hover:bg-violet-500">
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}{syncing ? '对账合并中' : '同步对账'}{sendableCount > 0 && !syncing ? ` (${sendableCount})` : ''}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}><Save className="h-4 w-4" />保存</Button>
          </div>
        </div>
      </header>

      {!effectiveOnline && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 lg:px-6">
          <CloudOff className="h-4 w-4 shrink-0" />
          <span>当前处于断网状态：所有译文、状态和讨论都会先攒在本地；网络恢复后自动按片段与远端对账，单边改动直接合并，两边都动过的片段会保留两版供挑选。</span>
        </div>
      )}
      {notice && (
        <div className={cn('flex items-start gap-2 border-b px-4 py-2 text-xs lg:px-6', noticeToneClass[notice.tone])}>
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="关闭提示"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="border-b bg-white/85 px-4 py-2.5 backdrop-blur lg:px-6">
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-600">
          <span><b className="text-slate-900">{segments.length}</b> 个内容块</span>
          <span><b className="text-slate-900">{translatedCount}</b> 已翻译</span>
          <span className="flex items-center gap-1"><CircleAlert className="h-3.5 w-3.5 text-amber-600" /><b className="text-slate-900">{issues.length}</b> 个检查结果</span>
          <span className="flex items-center gap-1"><CheckCheck className="h-3.5 w-3.5 text-emerald-600" /><b className="text-slate-900">{confirmedCount}</b> 已确认</span>
          <span className="flex items-center gap-1"><CloudUpload className="h-3.5 w-3.5 text-violet-600" /><b className="text-slate-900">{sendableCount}</b> 待同步{conflicts.length > 0 && <>, <b className="text-red-600">{conflicts.length}</b> 待挑版本</>}</span>
          <div className="ml-auto flex min-w-[220px] items-center gap-3"><span>审校进度 {progress}%</span><Progress value={progress} className="w-36" /></div>
          <Button size="sm" variant="secondary" onClick={handleCheck} disabled={checkMutation.isPending}>{checkMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}运行本地术语检查</Button>
          <Button size="sm" variant="outline" onClick={exportMarkdown}><Download className="h-4 w-4" />导出译文</Button>
        </div>
      </div>

      <main className="workbench-grid mx-auto grid max-w-[1800px] grid-cols-[270px_minmax(620px,1fr)_340px] gap-4 p-4 lg:p-5">
        <aside className="workbench-left space-y-4">
          <Card>
            <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm"><BookOpen className="h-4 w-4 text-blue-600" />本地术语表 <Badge variant="secondary">{glossary.length}</Badge></CardTitle><div className="relative mt-2"><Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" /><Input value={glossarySearch} onChange={(event) => setGlossarySearch(event.target.value)} placeholder="搜索术语" className="h-9 pl-8 text-xs" /></div></CardHeader>
            <CardContent className="space-y-2">
              {filteredGlossary.map((term) => <div key={term.id} className="rounded-lg border bg-slate-50/70 p-2.5"><div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-slate-800">{term.source}</span><ChevronRight className="h-3.5 w-3.5 text-slate-400" /><span className="text-xs font-semibold text-blue-700">{term.target}</span></div><p className="mt-1 text-[10px] leading-relaxed text-slate-500">{term.note}</p></div>)}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm"><AlertCircle className="h-4 w-4 text-amber-600" />问题导航 <Badge variant={issues.length ? 'warning' : 'success'}>{issues.length}</Badge></CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {issues.slice(0, 14).map((issue) => {
                const segment = segments.find((item) => item.id === issue.segmentId)
                return <button key={issue.id} className={cn('w-full rounded-lg border p-2.5 text-left transition hover:border-blue-300 hover:bg-blue-50', selectedSegmentId === issue.segmentId && 'border-blue-300 bg-blue-50')} onClick={() => selectAndScroll(issue.segmentId)}><div className="flex items-center justify-between gap-2"><Badge variant={issue.severity === 'error' ? 'destructive' : 'warning'}>{issueLabel[issue.type]}</Badge><span className="text-[10px] text-slate-400">#{segment?.index}</span></div><p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">{issue.message}</p></button>
              })}
              {!issues.length && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-center text-xs text-emerald-700"><Check className="mx-auto mb-2 h-5 w-5" />所有检查已通过</div>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm"><GitCompare className="h-4 w-4 text-violet-600" />批量退回</CardTitle></CardHeader>
            <CardContent>
              <p className="mb-3 text-[11px] leading-relaxed text-slate-500">在段落标题处勾选需要退回的片段，填写原因后统一提交。</p>
              <Textarea value={returnReason} onChange={(event) => setReturnReason(event.target.value)} rows={3} className="text-xs" />
              <Button className="mt-3 w-full" variant="destructive" disabled={!selectedForReturn.size || reviewMutation.isPending} onClick={bulkReturn}>{reviewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UndoDot className="h-4 w-4" />}批量退回 {selectedForReturn.size || ''}</Button>
            </CardContent>
          </Card>
        </aside>

        <section className="workbench-center min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-white p-2.5 shadow-sm">
            <div className="flex items-center rounded-lg bg-slate-100 p-1">
              {([['all', '全部'], ['issues', '问题'], ['untranslated', '漏译'], ['confirmed', '已确认']] as const).map(([value, label]) => <button key={value} onClick={() => setFilter(value)} className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition', filter === value ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>{label}</button>)}
            </div>
            <div className="ml-auto flex items-center gap-2 text-xs text-slate-500"><span>{filteredSegments.length} / {segments.length}</span><Button variant="outline" size="sm" onClick={() => nextIssue(-1)}><ArrowUp className="h-3.5 w-3.5" />上一问题</Button><Button variant="outline" size="sm" onClick={() => nextIssue(1)}>下一问题<ArrowDown className="h-3.5 w-3.5" /></Button></div>
          </div>

          {filteredSegments.map((segment) => {
            const segmentIssues = issueMap[segment.id] ?? []
            const isSelected = selectedSegment?.id === segment.id
            const isReturnSelected = selectedForReturn.has(segment.id)
            const syncEntry = outboxMap.get(segment.id)
            const hasConflict = conflictSegmentIds.has(segment.id)
            const isRejected = syncEntry?.status === 'rejected'
            return (
              <article id={`segment-${segment.id}`} key={segment.id} onClick={() => setSelectedSegmentId(segment.id)} className={cn('scroll-mt-32 overflow-hidden rounded-xl border bg-white shadow-sm transition', isSelected && 'ring-2 ring-blue-500/30', segment.status === 'returned' && 'border-red-200', segmentIssues.some((issue) => issue.severity === 'error') && 'border-red-200', hasConflict && 'border-violet-300 ring-1 ring-violet-200', isRejected && 'border-red-300')}>
                <header className="flex flex-wrap items-center gap-2 border-b bg-slate-50/80 px-3 py-2.5">
                  <input type="checkbox" checked={isReturnSelected} onChange={() => toggleReturnSelection(segment.id)} className="h-4 w-4 rounded border-slate-300 accent-blue-600" aria-label={`选择片段 ${segment.index}`} />
                  <span className="text-[11px] font-semibold text-slate-500">#{String(segment.index).padStart(2, '0')}</span>
                  <Badge variant="outline" className="gap-1 text-[10px]">{kindIcon[segment.kind]}{kindLabel[segment.kind]}</Badge>
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', statusClass[segment.status])}>{statusLabel[segment.status]}</span>
                  {hasConflict && <Badge className="bg-violet-100 text-violet-800">两边都动过 · 待挑版本</Badge>}
                  {!hasConflict && isRejected && <Badge variant="destructive">同步被拒 · 已退回</Badge>}
                  {!hasConflict && !isRejected && syncEntry && <Badge className="bg-amber-100 text-amber-800">{effectiveOnline ? '等待同步' : '断网暂存中'}</Badge>}
                  {segment.protectedTokens.length > 0 && <Badge variant="secondary" className="gap-1 text-[10px]"><Variable className="h-3 w-3" />{segment.protectedTokens.length} 个受保护标记</Badge>}
                  {!!segmentIssues.length && <Badge variant="destructive" className="ml-auto">{segmentIssues.length} 个问题</Badge>}
                  <div className={cn('flex gap-1.5', !segmentIssues.length && 'ml-auto')}>
                    {mode === 'review' && <><Button size="sm" variant="outline" className="border-emerald-300 text-emerald-700 hover:bg-emerald-50" onClick={(event) => { event.stopPropagation(); updateStatus(segment.id, 'confirmed') }}><Check className="h-3.5 w-3.5" />确认</Button><Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" onClick={(event) => { event.stopPropagation(); updateStatus(segment.id, 'returned') }}><X className="h-3.5 w-3.5" />退回</Button></>}
                  </div>
                </header>
                <div className="compare-grid grid grid-cols-2 divide-x">
                  <div className="min-w-0 p-3.5">
                    <div className="mb-2 flex items-center justify-between"><span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">English · Source</span><Badge variant="outline" className="text-[9px]">只读</Badge></div>
                    <div className={cn('document-prose text-sm leading-6 text-slate-700', segment.kind === 'code' && 'markdown-code rounded-lg bg-slate-950 p-3 text-xs text-slate-100')}>{segment.sourceText}</div>
                    {segment.note && <p className="mt-3 rounded-md bg-amber-50 px-2.5 py-1.5 text-[10px] text-amber-700">译者备注：{segment.note}</p>}
                  </div>
                  <div className="min-w-0 p-3.5">
                    <div className="mb-2 flex items-center justify-between"><span className="text-[10px] font-semibold uppercase tracking-wider text-blue-500">简体中文 · Target</span>{mode === 'translate' ? <Badge variant="outline" className="text-[9px]">编辑中</Badge> : <Badge variant="secondary" className="text-[9px]">审校只读</Badge>}</div>
                    <Textarea id={`target-${segment.id}`} value={segment.targetText} readOnly={mode === 'review'} onChange={(event) => updateTarget(segment, event.target.value)} rows={Math.max(3, Math.ceil(segment.sourceText.length / 46))} className={cn('min-h-[84px] resize-y border-slate-200 bg-slate-50/40 text-sm leading-6 focus-visible:bg-white', segment.kind === 'code' && 'markdown-code text-xs')} placeholder="在此输入译文，或保留代码块原样…" />
                    {segment.protectedTokens.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{segment.protectedTokens.map((token) => <code key={token} className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">{token}</code>)}</div>}
                    {isRejected && syncEntry?.rejectReason && <p className="mt-2 flex items-start gap-1 rounded-md bg-red-50 px-2 py-1.5 text-[10px] leading-4 text-red-700"><RotateCcw className="mt-0.5 h-3 w-3 shrink-0" />{syncEntry.rejectReason} 修改该片段后会自动重新进入同步。</p>}
                  </div>
                </div>
                {!!segmentIssues.length && <div className="border-t bg-red-50/50 px-3.5 py-2.5"><div className="space-y-1.5">{segmentIssues.map((issue) => <div key={issue.id} className="flex items-start gap-2 text-[11px]"><CircleAlert className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', issue.severity === 'error' ? 'text-red-600' : 'text-amber-600')} /><span className={issue.severity === 'error' ? 'text-red-700' : 'text-amber-700'}>{issue.message}</span></div>)}</div></div>}
                <footer className="flex items-center gap-2 border-t bg-white px-3 py-2 text-[10px] text-slate-400"><span>点击正文可切换当前片段</span><span>·</span><span>{effectiveOnline ? '改动即时进入同步队列' : '断网改动已攒在本地'}</span><button className="ml-auto flex items-center gap-1 text-blue-600 hover:underline" onClick={(event) => { event.stopPropagation(); setSelectedSegmentId(segment.id); document.getElementById('discussion-tab')?.click() }}><MessageSquare className="h-3 w-3" />讨论 {discussions.filter((item) => item.segmentId === segment.id && !item.resolved).length}</button></footer>
              </article>
            )
          })}
          {!filteredSegments.length && <Card><CardContent className="grid min-h-52 place-items-center text-center"><div><Sparkles className="mx-auto h-7 w-7 text-violet-500" /><p className="mt-3 text-sm font-medium">当前筛选下没有片段</p><p className="mt-1 text-xs text-slate-500">切换筛选条件或运行检查。</p></div></CardContent></Card>}
        </section>

        <aside className="workbench-right min-w-0">
          <Card className="sticky top-[74px] max-h-[calc(100vh-96px)] overflow-hidden">
            <Tabs defaultValue="discussion" className="flex h-full flex-col">
              <TabsList className="mx-3 mt-3 grid grid-cols-5">
                <TabsTrigger id="discussion-tab" value="discussion" className="px-1 text-[11px]">讨论</TabsTrigger>
                <TabsTrigger value="issues" className="px-1 text-[11px]">问题</TabsTrigger>
                <TabsTrigger value="history" className="px-1 text-[11px]">历史</TabsTrigger>
                <TabsTrigger value="conflicts" className="px-1 text-[11px]">冲突{conflicts.length ? ` ${conflicts.length}` : ''}</TabsTrigger>
                <TabsTrigger value="sync" className="px-1 text-[11px]">同步{sendableCount ? ` ${sendableCount}` : ''}</TabsTrigger>
              </TabsList>
              <TabsContent value="discussion" className="m-0 max-h-[calc(100vh-160px)] overflow-auto p-3">
                <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-2.5"><p className="text-[10px] font-semibold text-blue-800">当前片段 #{selectedSegment?.index}</p><p className="mt-1 line-clamp-3 text-xs leading-5 text-blue-700">{selectedSegment?.targetText || selectedSegment?.sourceText}</p></div>
                <div className="mt-3 flex gap-2"><Textarea value={discussionDraft} onChange={(event) => setDiscussionDraft(event.target.value)} rows={2} placeholder="针对当前句子留下讨论…" className="text-xs" /><Button size="icon" className="h-auto self-stretch" onClick={addDiscussion}><Send className="h-4 w-4" /></Button></div>
                <div className="mt-4 space-y-3">{selectedDiscussions.map((discussion) => <div key={discussion.id} className="rounded-lg border p-3"><div className="flex items-center justify-between"><b className="text-xs text-slate-800">{discussion.author}</b><Badge variant={discussion.resolved ? 'success' : 'warning'}>{discussion.resolved ? '已解决' : '待回应'}</Badge></div><p className="mt-2 text-xs leading-5 text-slate-600">{discussion.body}</p><p className="mt-2 text-[10px] text-slate-400">{hydrated ? new Date(discussion.createdAt).toLocaleString('zh-CN') : null}</p></div>)}{!selectedDiscussions.length && <p className="py-8 text-center text-xs text-slate-400">当前片段还没有讨论</p>}</div>
              </TabsContent>
              <TabsContent value="issues" className="m-0 max-h-[calc(100vh-160px)] overflow-auto p-3"><div className="space-y-2">{issues.map((issue) => <button key={issue.id} onClick={() => selectAndScroll(issue.segmentId)} className="w-full rounded-lg border p-3 text-left hover:border-amber-300 hover:bg-amber-50"><div className="flex items-center justify-between"><Badge variant={issue.severity === 'error' ? 'destructive' : 'warning'}>{issueLabel[issue.type]}</Badge><span className="text-[10px] text-slate-400">#{segments.find((item) => item.id === issue.segmentId)?.index}</span></div><p className="mt-2 text-xs leading-5 text-slate-600">{issue.message}</p></button>)}{!issues.length && <p className="py-8 text-center text-xs text-emerald-600">没有待处理问题</p>}</div></TabsContent>
              <TabsContent value="history" className="m-0 max-h-[calc(100vh-160px)] overflow-auto p-3"><div className="space-y-0">{history.map((entry) => <div key={entry.id} className="relative border-l border-slate-200 pb-4 pl-4"><span className="absolute -left-1.5 top-0 h-3 w-3 rounded-full border-2 border-white bg-blue-500" /><div className="flex items-center justify-between"><b className="text-[11px] text-slate-700">{entry.author}</b><span className="text-[9px] text-slate-400">{hydrated ? new Date(entry.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : null}</span></div><p className="mt-1 text-[10px] text-slate-500">片段 #{segments.find((item) => item.id === entry.segmentId)?.index ?? '—'} · {actionLabel[entry.action]}</p>{entry.after && <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-slate-400">{entry.after}</p>}</div>)}</div></TabsContent>
              <TabsContent value="conflicts" className="m-0 max-h-[calc(100vh-160px)] overflow-auto p-3"><div className="space-y-3">{conflicts.map((conflict) => {
                const segment = segments.find((item) => item.id === conflict.segmentId)
                return <div key={conflict.id} className="overflow-hidden rounded-lg border border-violet-200">
                  <div className="bg-violet-50 px-3 py-2"><b className="text-xs text-violet-800">片段 #{segment?.index ?? ''} · {conflict.reason === 'protected-tokens-dropped' ? '远端改动会冲掉占位符/链接' : '本地与远端都改过'}</b><p className="mt-1 text-[10px] text-violet-600">{conflict.remoteAuthor}</p></div>
                  <div className="space-y-2 p-3">
                    <div className="rounded-md border border-slate-200 p-2"><span className="text-[9px] font-semibold text-slate-400">本地版本</span><p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-slate-600">{conflict.localText || '（空）'}</p></div>
                    <div className="rounded-md border border-blue-200 bg-blue-50/60 p-2"><span className="text-[9px] font-semibold text-blue-500">远端版本</span><p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-blue-700">{conflict.remoteText || '（空）'}</p></div>
                    {!!conflict.protectTokens?.length && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-700">受保护标记不能丢：{conflict.protectTokens.join('、')}。采用远端时会自动补回文末，再请你挪到正确位置。</p>}
                    <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => keepLocalVersion(conflict)}>保留本地并同步</Button><Button size="sm" onClick={() => adoptRemoteVersion(conflict)}>采用远端版本</Button></div>
                  </div>
                </div>
              })}{!conflicts.length && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-center text-xs text-emerald-700"><Check className="mx-auto mb-2 h-5 w-5" />没有待挑选的两版冲突</div>}</div></TabsContent>
              <TabsContent value="sync" className="m-0 max-h-[calc(100vh-160px)] overflow-auto p-3">
                <div className="space-y-3">
                  <div className={cn('rounded-lg border p-3', effectiveOnline ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50')}>
                    <div className="flex items-center gap-2"><b className={cn('text-xs', effectiveOnline ? 'text-emerald-800' : 'text-amber-800')}>{effectiveOnline ? '网络在线' : '断网 · 本地暂存'}</b>{effectiveOnline ? <Cloud className="h-3.5 w-3.5 text-emerald-600" /> : <CloudOff className="h-3.5 w-3.5 text-amber-600" />}</div>
                    <p className="mt-1 text-[10px] leading-4 text-slate-500">同步按片段对账：单边改动直接采用；两边都动过留两版；被拒片段只退回自己，其余照常同步。</p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" className="flex-1" disabled={syncing || !effectiveOnline} onClick={() => void runSync()}>{syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudUpload className="h-3.5 w-3.5" />}立即对账合并</Button>
                      <Button size="sm" variant="outline" onClick={() => setSimulateOffline((value) => !value)}>{simulateOffline ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}{simulateOffline ? '恢复网络' : '模拟断网'}</Button>
                    </div>
                  </div>

                  <div>
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">本地同步队列 · {outbox.length}</p>
                    <div className="space-y-2">
                      {outbox.map((entry) => {
                        const segment = segments.find((item) => item.id === entry.segmentId)
                        const waiting = conflictSegmentIds.has(entry.segmentId)
                        return <div key={entry.segmentId} className={cn('rounded-lg border p-2.5', entry.status === 'rejected' ? 'border-red-200 bg-red-50/60' : waiting ? 'border-violet-200 bg-violet-50/60' : 'border-slate-200 bg-slate-50/60')}>
                          <div className="flex items-center justify-between gap-2">
                            <b className="text-[11px] text-slate-700">片段 #{segment?.index ?? entry.segmentId}</b>
                            {entry.status === 'rejected'
                              ? <Badge variant="destructive">远端已拒绝</Badge>
                              : waiting ? <Badge className="bg-violet-100 text-violet-800">待挑版本</Badge> : <Badge className="bg-amber-100 text-amber-800">{effectiveOnline ? '待同步' : '断网暂存'}</Badge>}
                          </div>
                          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[10px] leading-4 text-slate-500">{entry.localText || '（空译文）'}</p>
                          {entry.status === 'rejected' && <p className="mt-1 text-[10px] leading-4 text-red-700">{entry.rejectReason}</p>}
                          {entry.status === 'rejected' && <p className="mt-1 text-[10px] text-slate-400">在正文里修改该片段即自动重试；也可直接再同步一次。</p>}
                          <div className="mt-1 text-[9px] text-slate-400">{new Date(entry.updatedAt).toLocaleTimeString('zh-CN')} · 已尝试 {entry.attempts} 次</div>
                        </div>
                      })}
                      {!outbox.length && <p className="rounded-lg border border-emerald-200 bg-emerald-50 py-4 text-center text-[11px] text-emerald-700">本地没有待同步的改动</p>}
                    </div>
                  </div>

                  <div>
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">同步记录</p>
                    <div className="space-y-2">
                      {syncLogs.map((log) => <div key={log.id} className="rounded-lg border border-slate-200 p-2.5">
                        <div className="flex items-center justify-between">
                          <Badge variant={log.connected ? 'success' : 'warning'} className="text-[9px]">{log.connected ? '已联网对账' : '本地暂存'}</Badge>
                          <span className="text-[9px] text-slate-400">{new Date(log.at).toLocaleString('zh-CN', { hour12: false })}</span>
                        </div>
                        <p className="mt-1.5 text-[10px] leading-4 text-slate-600">{log.message}</p>
                      </div>)}
                      {!syncLogs.length && <p className="py-3 text-center text-[10px] text-slate-400">还没有同步记录</p>}
                    </div>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </Card>
          <div className="mt-3 rounded-xl border bg-slate-950 px-3 py-3 text-[10px] text-slate-400"><p className="mb-2 font-semibold text-slate-200">键盘操作</p><div className="grid grid-cols-2 gap-2"><span><kbd>J</kbd> 下一问题</span><span><kbd>K</kbd> 上一问题</span><span><kbd>C</kbd> 确认</span><span><kbd>R</kbd> 退回</span><span><kbd>⌘ Z</kbd> 撤销</span><span><kbd>⌘ ⇧ Z</kbd> 重做</span></div></div>
        </aside>
      </main>

      {selectedForReturn.size > 0 && <div className="fixed bottom-0 left-0 right-0 z-50 border-t bg-slate-950 px-4 py-3 text-white shadow-2xl"><div className="mx-auto flex max-w-[1800px] items-center gap-3"><ShieldCheck className="h-4 w-4 text-amber-300" /><span className="text-xs">已选择 <b>{selectedForReturn.size}</b> 个片段{!effectiveOnline && '（断网：退回状态先攒本地）'}</span><Input value={returnReason} onChange={(event) => setReturnReason(event.target.value)} className="ml-auto max-w-lg border-slate-700 bg-slate-900 text-white" /><Button variant="destructive" size="sm" onClick={bulkReturn}>确认批量退回</Button><Button variant="ghost" size="sm" className="text-slate-300" onClick={() => setSelectedForReturn(new Set())}>取消</Button></div></div>}
    </div>
  )
}
