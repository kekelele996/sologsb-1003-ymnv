export type SegmentKind = 'heading' | 'paragraph' | 'code' | 'link' | 'variable'
export type SegmentStatus = 'draft' | 'needs-work' | 'confirmed' | 'returned'
export type IssueType = 'missing-translation' | 'missing-variable' | 'link-mismatch' | 'glossary' | 'code-format'
export type IssueSeverity = 'error' | 'warning'

export interface Segment {
  id: string
  index: number
  kind: SegmentKind
  sourceText: string
  targetText: string
  status: SegmentStatus
  protectedTokens: string[]
  note: string
}

export interface GlossaryTerm {
  id: string
  source: string
  target: string
  caseSensitive: boolean
  note: string
}

export interface Discussion {
  id: string
  segmentId: string
  author: string
  body: string
  resolved: boolean
  createdAt: number
}

export interface TranslationIssue {
  id: string
  segmentId: string
  type: IssueType
  severity: IssueSeverity
  message: string
  expected?: string
}

export interface HistoryEntry {
  id: string
  segmentId: string
  author: string
  action: 'edit' | 'confirm' | 'return' | 'resolve-conflict' | 'import' | 'discussion' | 'sync'
  before: string
  after: string
  createdAt: number
}

export interface TranslationConflict {
  id: string
  segmentId: string
  localText: string
  remoteText: string
  remoteAuthor: string
  createdAt: number
  /** 本地/远端状态，用于采用某一版时连状态一起落盘。 */
  localStatus?: SegmentStatus
  remoteStatus?: SegmentStatus
  /** 触发原因：两边都改过，或远端单边改动丢失了占位符/链接。 */
  reason?: 'both-modified' | 'protected-tokens-dropped'
  /** 采用远端版本时必须补回的受保护标记。 */
  protectTokens?: string[]
}

/** 断网期间攒在本地、等待与远端对账的单片段改动。 */
export interface PendingSegmentChange {
  segmentId: string
  /** 最近一次同步成功时的基线内容。 */
  baseText: string
  baseStatus: SegmentStatus
  /** 本地当前内容（同步前快照，被远端拒绝时按它回退）。 */
  localText: string
  localStatus: SegmentStatus
  /** 译者在冲突卡片上选择“保留本地”后强制推送。 */
  force: boolean
  status: 'pending' | 'rejected'
  rejectReason?: string
  attempts: number
  updatedAt: number
}

/** 每个片段最近一次与远端一致时的快照。 */
export interface SyncedSegmentSnapshot {
  segmentId: string
  targetText: string
  status: SegmentStatus
}

/** 远端文档中某片段的当前状态。 */
export interface RemoteSegmentState {
  segmentId: string
  targetText: string
  status: SegmentStatus
  author: string
  updatedAt: number
}

export interface SyncChangeRequest {
  segmentId: string
  baseText: string
  baseStatus: SegmentStatus
  localText: string
  localStatus: SegmentStatus
  force: boolean
}

export type SyncItemStatus = 'accepted' | 'conflict' | 'rejected'

export interface SyncItemResult {
  segmentId: string
  status: SyncItemStatus
  reason?: string
  remoteText?: string
  remoteStatus?: SegmentStatus
  remoteAuthor?: string
}

export interface SyncResponse {
  syncedAt: number
  revision: number
  results: SyncItemResult[]
  remote: RemoteSegmentState[]
}

export interface SyncLog {
  id: string
  at: number
  connected: boolean
  accepted: number
  rejected: number
  conflicts: number
  pulled: number
  message: string
}

export interface LocalizationDocument {
  id: string
  title: string
  sourceFile: string
  sourceLanguage: string
  targetLanguage: string
  updatedAt: number
  segments: Segment[]
  glossary: GlossaryTerm[]
  discussions: Discussion[]
}
