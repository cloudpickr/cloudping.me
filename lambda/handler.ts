import { authorized } from '../src/fns/probe-auth'
import { runProbe } from '../src/fns/probe-server'

type FunctionUrlEvent = {
  requestContext?: { http?: { method?: string } }
  headers?: Record<string, string>
}

function json(statusCode: number, body: unknown, extra?: Record<string, string>) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
    body: JSON.stringify(body),
  }
}

export async function handler(event: FunctionUrlEvent) {
  const method = event.requestContext?.http?.method || 'GET'
  if (method !== 'POST') {
    return json(405, { error: 'method not allowed' }, { Allow: 'POST' })
  }
  const headers = event.headers || {}
  const auth = headers.authorization || headers.Authorization
  if (!authorized(auth)) {
    return json(401, { error: 'unauthorized' })
  }
  // AWS Lambda origins showed near-cell latency jitter (min/median stable, max
  // spiking 4-12x) that GCP/Azure didn't — same shared runProbe(), so it was the
  // Lambda execution env, not the code: the small Lambda's event loop stalled under
  // fan-out and that scheduling delay landed on the measured wall-clock. Fix, in
  // order: raised memory 256MB->512MB (~0.15->~0.28 vCPU), then set concurrency 12.
  // Live data after both: the smoking-gun same-metro cells (e.g. Seoul->Seoul) went
  // from ~10x max/median down to ~1.2x, and round duration dropped ~82s->~52s.
  // 12 is ~42 in-flight/vCPU — below the density that used to jitter; 16 (~57/vCPU)
  // would climb back to the old 256MB/conc-8 contention, so we stop at 12. Still
  // env-tunable for A/B without a redeploy. Only AWS goes through this handler, so
  // GCP/Azure keep runProbe's own default.
  const parsed = Number(process.env.PROBE_CONCURRENCY)
  const concurrency = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 12
  const snapshot = await runProbe(concurrency)
  // Cheap diagnostic (no extra requests): share of cells that failed this round.
  // Shorter timeouts + fewer samples can raise failures, making the survivors look
  // artificially fast — this ratio surfaces that so the jitter fix isn't misread.
  const total = snapshot.results.length
  const failed = snapshot.results.filter((r) => !r.ok).length
  console.log(
    JSON.stringify({
      probe: snapshot.probe.id,
      concurrency,
      durationMs: snapshot.probe.durationMs,
      cells: total,
      failed,
      failRate: total ? Number((failed / total).toFixed(3)) : 0,
    })
  )
  return json(200, snapshot)
}
