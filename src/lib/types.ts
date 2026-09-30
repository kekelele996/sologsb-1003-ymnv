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
  action: 'edit' | 'confirm' | 'return' | 'resolve-conflict' | 'import' | 'discussion'
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
  baseText?: string
}

/** A single offline edit queued locally until the network recovers. */
export interface OutboxEntry {
  segmentId: string
  /** Segment text at the last successful sync — the three-way merge base. */
  baseText: string
  /** The translator's offline edit (raw, before token-safe merge). */
  localText: string
  status: 'pending' | 'failed'
  attempts: number
  lastError?: string
  queuedAt: number
}

/** Per-segment result returned by the remote after a sync push. */
export type SyncResultStatus = 'accepted' | 'rejected' | 'conflict'

export interface SyncResult {
  segmentId: string
  status: SyncResultStatus
  remoteText?: string
  remoteAuthor?: string
  reason?: string
  message?: string
}

export interface SyncResponse {
  syncedAt: number
  results: SyncResult[]
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
