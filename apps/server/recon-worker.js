// Recon worker — runs a scan in a SEPARATE process so a large/slow repo can never block the server's event loop
// (the portal stays responsive and progress streams genuinely live, not replayed). The parent forks this and talks
// over IPC: { type:'start', dataRoot, projectId, missionId } in → { type:'event'|'done'|'error' } out.
import { scanSnapshot } from '../../packages/recon/index.js'
import { renderPhase1Maps } from '../../packages/markdown-renderer/index.js'

process.on('message', async (msg) => {
  if (!msg || msg.type !== 'start') return
  const { dataRoot, projectId, missionId } = msg
  const send = (m) => { try { process.send(m) } catch {} }
  try {
    const res = await scanSnapshot(dataRoot, projectId, {
      missionId,
      onPhase: (ev) => send({ type: 'event', ev }),
      onProgress: (ev) => send({ type: 'event', ev }),
      render: (db, out, meta) => renderPhase1Maps(db, out, meta),
    })
    send({ type: 'done', summary: {
      mission: missionId, snapshotId: res.snapshotId, graph: res.graph, features: res.coverage.feature_count,
      gate: res.gate.status, gaps: res.gate.gaps, domains: res.domains, reused: res.publication.reused,
      blocked: res.gate.status === 'SEMANTIC_PLANNING_BLOCKED', executed_planner: res.publication.executed_planner,
      lead_session: res.publication.lead_session_id, failure_reason: res.publication.failure_reason,
      semantic_coverage: res.coverage.semantic_coverage, technical_coverage: res.coverage.technical_coverage,
      technical_clusters: res.coverage.technical_clusters,
    } })
  } catch (e) {
    send({ type: 'error', message: String((e && e.message) || e) })
  }
  // give IPC a tick to flush, then exit
  setTimeout(() => process.exit(0), 50)
})
