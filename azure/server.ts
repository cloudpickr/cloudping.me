import { createServer } from 'http'
import { authorized } from '../src/fns/probe-auth'
import { runProbe } from '../src/fns/probe-server'

// Azure App Service (F1 Free) probe origin. Same runProbe + PROBE_SECRET auth as
// the AWS Lambda / GCP Cloud Run origins, exposed as a plain HTTP server. App
// Service injects PORT (default 8080 here for local runs). Kept at parity with
// the AWS/GCP conditions (identical probe logic/constants, timeout 300s) so
// /health From-column comparisons stay fair.
//
// Far-target timeouts on Azure origins show block-failure patterns consistent with
// transport/socket contention or SNAT port pressure under burst fan-out (24).
// Azure origins default to concurrency 8 (matching AWS Lambda). Origins that
// reproduced large provider-independent failure blocks use a targeted free-tier
// experiment at concurrency 4, while the other Azure origins remain controls at 8.
// PROBE_CONCURRENCY still overrides either default for operator A/B tests. Neither
// value enforces a hard socket ceiling, and the 270s workflow caller budget remains
// the adoption guardrail.
//
// F1 apps are public, so auth is purely app-level: the GitHub Actions workflow
// sends the PROBE_SECRET as `Authorization: Bearer`. (X-Probe-Secret is also
// accepted for symmetry with the Cloud Run origin.)

const PORT = Number(process.env.PORT) || 8080
const DEFAULT_CONCURRENCY = 8
const REDUCED_CONCURRENCY = 4
const REDUCED_CONCURRENCY_ORIGINS = new Set(['azure-eastus2', 'azure-israelcentral', 'azure-koreacentral', 'azure-southeastasia', 'azure-westindia'])

function defaultConcurrency(): number {
  return REDUCED_CONCURRENCY_ORIGINS.has(process.env.PROBE_ORIGIN_ID || '') ? REDUCED_CONCURRENCY : DEFAULT_CONCURRENCY
}

interface ActiveRun {
  id: string
  startedAt: number
}

let activeRun: ActiveRun | null = null
let runSequence = 0

const server = createServer((req, res) => {
  void (async () => {
    const method = req.method || 'GET'
    if (method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', Allow: 'POST' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    const secretHeader = req.headers['x-probe-secret']
    const appAuth = typeof secretHeader === 'string' && secretHeader.length > 0 ? `Bearer ${secretHeader}` : req.headers.authorization
    if (!authorized(appAuth)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    if (activeRun) {
      const elapsedMs = Date.now() - activeRun.startedAt
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({ event: 'probe-overlap-rejected', activeRunId: activeRun.id, elapsedMs }))
      res.writeHead(429, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '30' })
      res.end(JSON.stringify({ error: 'probe already running', runId: activeRun.id, elapsedMs }))
      return
    }

    const runId = `${Date.now().toString(36)}-${++runSequence}`
    const startedAt = Date.now()
    const cpuStarted = process.cpuUsage()
    activeRun = { id: runId, startedAt }

    try {
      const parsed = Number(process.env.PROBE_CONCURRENCY)
      const fallbackConcurrency = defaultConcurrency()
      const concurrency = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallbackConcurrency
      const snapshot = await runProbe(concurrency)
      const total = snapshot.results.length
      const failed = snapshot.results.filter((r) => !r.ok).length
      const cpu = process.cpuUsage(cpuStarted)
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          event: 'probe-round',
          runId,
          probe: snapshot.probe.id,
          concurrency,
          fallbackConcurrency,
          durationMs: snapshot.probe.durationMs,
          cells: total,
          failed,
          failRate: total ? Number((failed / total).toFixed(3)) : 0,
          cpuUserMs: Math.round(cpu.user / 1000),
          cpuSystemMs: Math.round(cpu.system / 1000),
          rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        })
      )
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(snapshot))
    } catch (err) {
      const cause = err instanceof Error && err.cause && typeof err.cause === 'object' ? (err.cause as { code?: string }) : undefined
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ event: 'probe-round-failed', runId, elapsedMs: Date.now() - startedAt, causeCode: cause?.code }))
      res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'probe failed' }))
    } finally {
      if (activeRun?.id === runId) activeRun = null
    }
  })()
})

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`cloudping probe listening on :${PORT}`)
})
