import type { Discussion, GlossaryTerm, HistoryEntry, LocalizationDocument, RemoteSegmentState, Segment, SyncedSegmentSnapshot, TranslationConflict } from './types'

export const seedSegments: Segment[] = [
  { id: 'seg-01', index: 1, kind: 'heading', sourceText: '# Deployment Guide', targetText: '# 部署指南', status: 'confirmed', protectedTokens: [], note: '保留 Markdown 标题层级。' },
  { id: 'seg-02', index: 2, kind: 'paragraph', sourceText: 'This guide explains how to deploy {{project_name}} version {{version}} to a Kubernetes cluster.', targetText: '本指南介绍如何将 {{project_name}} {{version}} 版部署到 Kubernetes 集群。', status: 'draft', protectedTokens: ['{{project_name}}', '{{version}}'], note: '项目名和版本号保留占位符。' },
  { id: 'seg-03', index: 3, kind: 'heading', sourceText: '## Prerequisites', targetText: '## 前置条件', status: 'confirmed', protectedTokens: [], note: '' },
  { id: 'seg-04', index: 4, kind: 'link', sourceText: 'Before you begin, review the [configuration reference](https://docs.example.com/config) and install `kubectl`.', targetText: '开始前，请阅读 [配置参考](https://docs.example.com/config)，并安装 `kubectl`。', status: 'draft', protectedTokens: ['https://docs.example.com/config'], note: '' },
  // seg-05 本地有一笔断网期间的改动（相对基线），远端同事同时也改了同一句 → 首次同步即两边都动过
  { id: 'seg-05', index: 5, kind: 'paragraph', sourceText: 'The operator requires cluster-admin privileges during installation. Production environments should use a dedicated service account.', targetText: '安装时 operator 需要集群管理员权限。生产环境建议使用专用的服务账号。', status: 'needs-work', protectedTokens: [], note: 'operator 的术语待 unified。' },
  { id: 'seg-06', index: 6, kind: 'code', sourceText: '```bash\nhelm upgrade --install {{release_name}} oci://registry.example.com/operator --version {{version}}\n```', targetText: '```bash\nhelm upgrade --install {{release_name}} oci://registry.example.com/operator --version {{version}}\n```', status: 'confirmed', protectedTokens: ['{{release_name}}', '{{version}}'], note: '命令保持原样。' },
  { id: 'seg-07', index: 7, kind: 'variable', sourceText: 'Set `replicaCount` to `{replica_count}` in your values file.', targetText: '在 values 文件中将 `replicaCount` 设置为 `{replica_count}`。', status: 'draft', protectedTokens: ['{replica_count}'], note: '' },
  { id: 'seg-08', index: 8, kind: 'paragraph', sourceText: 'If the controller cannot reach the API server, check the network policy and then restart the pod.', targetText: '如果控制器无法连接 API 服务器，请检查网络策略，然后重启 Pod。', status: 'draft', protectedTokens: [], note: '' },
  { id: 'seg-09', index: 9, kind: 'link', sourceText: 'See [Troubleshooting](https://docs.example.com/troubleshooting#connectivity) for detailed diagnostics.', targetText: '详细诊断请参阅 [故障排查](https://docs.example.com/troubleshooting)。', status: 'returned', protectedTokens: ['https://docs.example.com/troubleshooting#connectivity'], note: '锚点链接丢失，需要修复。' },
  { id: 'seg-10', index: 10, kind: 'heading', sourceText: '## Upgrade Notes', targetText: '', status: 'draft', protectedTokens: [], note: '漏译示例。' },
]

export const seedGlossary: GlossaryTerm[] = [
  { id: 'term-01', source: 'operator', target: 'Operator', caseSensitive: false, note: 'Kubernetes 扩展概念，保留首字母大写。' },
  { id: 'term-02', source: 'service account', target: '服务账号', caseSensitive: false, note: '统一使用“服务账号”。' },
  { id: 'term-03', source: 'network policy', target: '网络策略', caseSensitive: false, note: 'Kubernetes 资源名称。' },
  { id: 'term-04', source: 'pod', target: 'Pod', caseSensitive: false, note: '资源对象名称保持 Pod。' },
]

export const seedDiscussions: Discussion[] = [
  { id: 'disc-01', segmentId: 'seg-05', author: '译者 · 李然', body: '这里的 operator 指本项目控制器还是通用 Kubernetes Operator？会影响是否保留英文。', resolved: false, createdAt: Date.now() - 4200000 },
  { id: 'disc-02', segmentId: 'seg-09', author: '审校 · Maya', body: '源链接包含 connectivity 锚点，请勿省略。', resolved: false, createdAt: Date.now() - 2600000 },
  { id: 'disc-03', segmentId: 'seg-02', author: '术语负责人 · Chen', body: '占位符里的变量名不能翻译。', resolved: true, createdAt: Date.now() - 9600000 },
]

export const seedHistory: HistoryEntry[] = [
  { id: 'h-01', segmentId: 'seg-05', author: '译者 · 李然', action: 'edit', before: '', after: '安装 operator 时需要集群管理员权限。生产环境建议使用专用的服务账号。', createdAt: Date.now() - 5200000 },
  { id: 'h-02', segmentId: 'seg-09', author: '译者 · 李然', action: 'edit', before: '', after: '详细诊断请参阅 [故障排查](https://docs.example.com/troubleshooting)。', createdAt: Date.now() - 4000000 },
  { id: 'h-03', segmentId: 'seg-01', author: '审校 · Maya', action: 'confirm', before: '# 部署指南', after: '# 部署指南', createdAt: Date.now() - 3200000 },
]

// 冲突不再静态预置：首次同步时按 基线/本地/远端 三向对账真实生成。
export const seedConflicts: TranslationConflict[] = []

/** 首次同步前各片段的共同基线：seg-05 的基线是本地改动之前的旧译文。 */
export const seedSyncedBaseline: SyncedSegmentSnapshot[] = seedSegments.map((segment) => ({
  segmentId: segment.id,
  targetText: segment.id === 'seg-05'
    ? '安装 operator 时需要集群管理员权限。生产环境建议使用专用的服务账号。'
    : segment.targetText,
  status: segment.status,
}))

const remoteNow = Date.now()

/**
 * 远端文档当前状态（模拟同事在断网期间的改动）：
 * - seg-01 同事补译并确认；seg-03 仅状态变更 → 只有远端动过，照远端走
 * - seg-02 远端版本丢了 {{version}} 占位符 → 不自动冲掉，转冲突人工挑
 * - seg-05 同事同时改了同一句 → 与本地改动两边都动过，留两版
 * - seg-09 同事修好了 connectivity 锚点 → 只有远端动过，照远端走
 */
export const seedRemoteSegments: RemoteSegmentState[] = seedSegments.map((segment) => ({
  segmentId: segment.id,
  targetText: segment.targetText,
  status: segment.status,
  author: '远端 · 协作者',
  updatedAt: remoteNow,
}))

const patchRemote = (segmentId: string, patch: Partial<RemoteSegmentState>) => {
  const target = seedRemoteSegments.find((segment) => segment.segmentId === segmentId)
  if (target) Object.assign(target, patch, { updatedAt: remoteNow })
}

patchRemote('seg-01', { targetText: '# 部署指南', status: 'confirmed' })
patchRemote('seg-02', { targetText: '本指南介绍如何将 {{project_name}} 部署到 Kubernetes 集群。', author: '远端协作者 · Alex' })
patchRemote('seg-03', { status: 'confirmed', author: '审校 · Maya' })
patchRemote('seg-05', { targetText: '安装 Operator 时需要集群管理员权限。生产环境应使用专用服务账号。', author: '远端协作者 · Alex' })
patchRemote('seg-08', { targetText: '若控制器无法访问 API 服务器，请检查网络策略，然后再重启 Pod。', author: '远端协作者 · Alex' })
patchRemote('seg-09', { targetText: '详细诊断请参阅 [故障排查](https://docs.example.com/troubleshooting#connectivity)。', author: '审校 · Maya', status: 'confirmed' })

export const seedDocument: LocalizationDocument = {
  id: 'doc-k8s-operator',
  title: 'Kubernetes Operator Developer Guide',
  sourceFile: 'docs/deployment.md',
  sourceLanguage: 'English',
  targetLanguage: '简体中文',
  updatedAt: Date.now(),
  segments: seedSegments,
  glossary: seedGlossary,
  discussions: seedDiscussions,
}
