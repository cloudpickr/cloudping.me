import { getAllCloudRegions, getAllProviders } from '@app/data'
import type { ProbeResult, ProbeSnapshot } from './probe-snapshot'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import diagnosticsChannel from 'node:diagnostics_channel'
import { setDefaultResultOrder, lookup as dnsLookup } from 'node:dns'
import { setDefaultAutoSelectFamilyAttemptTimeout, connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { withCacheBuster, MIN_PLAUSIBLE_MS } from './measure-core'

// Global fetch (undici) connects via net's Happy Eyeballs, which tries the
// resolved addresses one at a time and abandons each after the attempt timeout
// (Node's default is 250ms). Linode object storage returns both A and AAAA
// records; from GCP Cloud Run Seoul/Mumbai, IPv6 egress to Linode EU (and
// br-gru) is silently blackholed, and the IPv4 RTT there is ~270-300ms — longer
// than the 250ms attempt window — so every IPv4 attempt was killed before its
// SYN-ACK arrived and the whole address walk outran the 3s probe timeout (curl,
// which uses a longer Happy-Eyeballs timer, reached the same hosts in ~0.9s).
// Fix, verified from GCP Seoul with plain global fetch: try IPv4 first and give
// each attempt 750ms — longer than any real IPv4 RTT — so a dual-stack target
// connects on the first IPv4 address (~0.85-1.05s, within budget), while an
// AAAA-only host or a broken-IPv4 host still falls back to IPv6. Both are
// process-wide Node built-ins, so nothing is added to the bundle. (All 343
// current probe targets have an A record, so no target regresses.)
setDefaultResultOrder('ipv4first')
setDefaultAutoSelectFamilyAttemptTimeout(750)

// --- cgroup v2 CPU-throttle reader (diagnostic only) ------------------------
// Lambda (Amazon Linux 2023) caps a function's CPU with a cgroup v2 quota
// proportional to memory (1.8GB ≈ 1 vCPU, so 512MB ≈ 0.28 vCPU). When a round's
// concurrent fan-out exhausts that quota within a scheduling period, the kernel
// PARKS the whole process until the next period — 10–40ms stalls that
// performance.now() elapsed absorbs, inflating near-cell latency. cpu.stat's
// nr_throttled / throttled_usec count exactly those parks. Reading it before and
// after the pool turns the current INFERENCE ("event-loop delay looks high, so
// it's probably CPU throttling") into DIRECT evidence: seconds of throttled_usec
// per round confirms the quota is the cause; near-zero refutes it. cpu.max gives
// the quota/period so the numbers are interpretable. All reads are best-effort:
// --- CPU-starvation diagnostic (diagnostic only) ----------------------------
// The near-cell-inflation hypothesis is that the 512MB Lambda's CPU quota
// (~0.28 vCPU) is exhausted during the concurrent fan-out, so the kernel parks
// the whole process for 10–40ms and performance.now() elapsed absorbs the wait.
// The obvious source, cgroup v2 cpu.stat (nr_throttled/throttled_usec), is NOT
// available: the Lambda microVM does not mount /sys/fs/cgroup at all (ENOENT),
// verified empirically. So we measure the effect two dependency-free ways that
// DO work in the sandbox:
//
// 1. process.cpuUsage(): CPU microseconds (user+system) actually consumed. The
//    ratio cpuMs/wallMs over the pool phase is the effective CPU utilization.
//    If the process is compute-starved against a ~0.28 vCPU cap, the ratio
//    presses toward that ceiling while wall time stretches; a low ratio means
//    the round is I/O-bound and CPU isn't the bottleneck.
// 2. A periodic SPIN PROBE: run a fixed, known amount of pure synchronous work
//    and measure its wall time. If a spin whose CPU cost is ~1ms sometimes takes
//    20–40ms of wall time, the process was descheduled mid-spin — direct,
//    unambiguous evidence of CPU parking that a per-fetch timer can't attribute.
//    We record the worst inflation factor (wall/cpu) seen across the round.

// Calibrated busy-work: a fixed iteration count whose synchronous cost is a few
// ms on this class of vCPU. Measured as wall vs cpu so parking shows up as
// wall >> cpu. Kept small (runs a handful of times per round) so it adds
// negligible GB-seconds and never competes meaningfully with real probes.
function spinOnce(iterations: number): { wallMs: number; cpuMs: number } {
  const c0 = process.cpuUsage()
  const w0 = performance.now()
  // Simple integer churn the JIT can't fully elide (accumulator is returned via
  // the throwaway check below). Pure CPU, no allocation, no I/O.
  let acc = 0
  for (let i = 0; i < iterations; i++) acc = (acc + i * 31 + 7) >>> 0
  const wallMs = performance.now() - w0
  const cpu = process.cpuUsage(c0)
  // Guard against the JIT eliding the loop entirely.
  if (acc === 0xffffffff) throw new Error('unreachable')
  return { wallMs, cpuMs: (cpu.user + cpu.system) / 1000 }
}

// --- Connection-establishment tracking (diagnostic only) --------------------
// Node's global fetch is undici under the hood, and undici publishes a
// 'undici:client:connected' diagnostics event every time it opens a NEW socket
// to an origin. We count those per-hostname so a probe sample can tell whether
// it reused a warm socket or paid a fresh TCP+TLS handshake. This is the signal
// that decides between the two live hypotheses for AWS self-cell bimodal
// latency: if the slow samples opened new connections, the ~15ms slow-mode
// offset is handshake cost; if they reused a socket, it's CPU/scheduling delay
// on the small Lambda vCPU (performance.now() elapsed absorbing a parked
// process). Subscribing is cheap and adds no probe requests. It's wrapped in a
// try/catch because the channel name is an undici implementation detail, not a
// stable public API — if a future Node renames it, probing must still work.
const connectCountByHost = new Map<string, number>()
try {
  diagnosticsChannel.subscribe('undici:client:connected', (message: unknown) => {
    try {
      const host = (message as { connectParams?: { hostname?: string } })?.connectParams?.hostname
      if (host) connectCountByHost.set(host, (connectCountByHost.get(host) ?? 0) + 1)
    } catch {
      /* never let diagnostics bookkeeping affect a probe */
    }
  })
} catch {
  /* channel unavailable: newConn stays undefined, probes unaffected */
}

// --- Egress-IP lookup (diagnostic only) -------------------------------------
// The China-blackhole investigation (claude + antigravity cross-review, plus
// production CloudWatch telemetry) concluded that AWS Tokyo/Seoul/Singapore
// rounds intermittently lose ALL mainland-China targets while Hong Kong (same
// pool, same CSPs, same TLS stack) keeps answering at ~54ms and cpuUtil stays
// ~0.09 with zero spin parking — i.e. it is NOT CPU park (the original guess,
// which a confounded throwaway-Lambda load test had wrongly implicated), but a
// Great-Firewall blackhole of specific Lambda egress IPs. To turn that from a
// strong inference into a proven 1:1 correlation, we record the round's egress
// IP so production logs can show whether blackhole rounds map to recurring IPs.
// One request per round, run in parallel with setup, hard-bounded, and wrapped
// so it can never fail or slow a round: on any error egressIp is simply null.
async function lookupEgressIp(): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  try {
    const res = await fetch('https://checkip.amazonaws.com', {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'cloudping.me-probe' },
    })
    const text = await res.text()
    const ip = text.trim()
    // checkip returns a bare "1.2.3.4\n"; validate each octet is 0-255 so a
    // hijacked/proxied response can't inject arbitrary text (or a malformed
    // "999.999.999.999") into the round summary.
    return /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ip) ? ip : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Classify a result as mainland China vs Hong Kong for the cnBlackhole flag.
// Mainland is the GFW-gated set (country 'CN'), explicitly EXCLUDING Hong Kong
// endpoints — note alibaba's `cn-hongkong` is catalogued country:'CN' but is
// physically outside the firewall and keeps succeeding during a blackhole, so
// it must not dilute the mainland signal. HK controls are country:'HK' plus
// that one mislabeled Alibaba entry.
function isMainlandChina(r: ProbeResult): boolean {
  return r.country === 'CN' && r.location !== 'Hong Kong'
}
function isHongKong(r: ProbeResult): boolean {
  return r.country === 'HK' || r.location === 'Hong Kong'
}

// --- Blackhole stage diagnostic (diagnostic only, cnBlackhole rounds only) --
// PR #81 proved the failure is source-side (per-execution-environment/egress-IP)
// and binary (all 20 mainland cells fail, all Hong Kong controls pass). But the
// probe only ever logs `timeout`, so the exact FAILURE STAGE is still inferred,
// not observed — and the two live mechanism hypotheses need different fixes:
//   • network-level blackhole (GFW null-routes the egress IP): even a raw SYN to
//     a literal mainland IP, with NO DNS involved, gets no reply → connect times
//     out. Fix space: force a fresh egress IP / static clean EIP.
//   • DNS-path failure (a hanging lookup for *.aliyuncs.com etc.; DNS runs inside
//     the same abort timer so it also surfaces as `timeout`): the DNS resolve
//     hangs but a raw SYN to a literal IP connects fine. Fix space: pin/pre-
//     resolve addresses — a completely different, deterministic change.
//   • SNI/TLS filtering: SYN connects, TLS handshake with the real SNI is reset
//     (RST/ECONNRESET) or hangs, even though the raw SYN succeeded.
// Run ONLY when cnBlackhole is already true (never on healthy rounds, so zero
// steady-state overhead), against ONE mainland host, fully time-bounded and
// wrapped so it can neither fail nor meaningfully slow the round. Separates the
// stages so the next fix is chosen on observation, not on another guess.
//
// Two review-driven refinements (Codex P1):
//  1. The SYN stage MUST NOT depend on the DNS lookup being diagnosed — if DNS
//     is the failing stage, dns.ip is null and a DNS-gated SYN would be skipped,
//     making a resolver stall indistinguishable from a network blackhole. So the
//     SYN runs against a STATIC known-mainland IP literal (no DNS at all); it
//     proves whether literal-IP networking to the mainland works regardless of
//     the resolver. (A blackhole drops SYNs to the whole mainland, so the exact
//     host behind the literal is irrelevant; a stale-but-real mainland IP still
//     tests the path.) We ALSO record the DNS result and, if DNS gave an IP,
//     a SYN to that resolved IP for completeness.
//  2. When the SYN succeeds we attempt a bounded TLS handshake with the real
//     hostname as SNI, so SNI/TLS filtering is OBSERVED (tlsOk:false + reset)
//     rather than inferred from "syn worked but the round failed".
type StageResult = { ms: number | null; ok: boolean; error: string | null }
type BlackholeStageDiag = {
  host: string
  // DNS resolution of the real mainland host (stage 1)
  dnsMs: number | null
  dnsOk: boolean
  dnsError: string | null
  resolvedIp: string | null
  // raw SYN to a STATIC mainland IP literal — DNS entirely out of the path
  synStaticIp: string
  synStaticMs: number | null
  synStaticOk: boolean
  synStaticError: string | null
  // raw SYN to the DNS-resolved IP (only if DNS succeeded) — for completeness
  synResolvedMs: number | null
  synResolvedOk: boolean
  synResolvedError: string | null
  // bounded TLS handshake with the real SNI, only attempted if a SYN succeeded
  tlsMs: number | null
  tlsOk: boolean
  tlsError: string | null
}

// Static mainland IP literals across CSPs (Alibaba OSS Hangzhou/Beijing, Tencent
// COS Beijing) for the DNS-independent SYN test. Multiple entries so a rotated
// IP doesn't blind the probe; the first reachable is used. These only need to be
// real mainland-hosted addresses — a GFW blackhole drops SYNs to the whole
// mainland, so the exact host is immaterial. Captured 2026-09-28.
const MAINLAND_IP_LITERALS = ['118.31.219.230', '59.110.190.88', '82.156.94.45']

function timedDnsLookup(host: string, timeoutMs: number): Promise<{ ms: number; ip: string | null; error: string | null }> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve({ ms: performance.now() - t0, ip: null, error: 'timeout' })
    }, timeoutMs)
    try {
      // ipv4first is set process-wide; ask for a single A record.
      dnsLookup(host, { family: 4 }, (err, address) => {
        if (done) {
          clearTimeout(timer)
          return
        }
        done = true
        clearTimeout(timer)
        if (err) resolve({ ms: performance.now() - t0, ip: null, error: (err as NodeJS.ErrnoException).code || err.name || 'error' })
        else resolve({ ms: performance.now() - t0, ip: address, error: null })
      })
    } catch (err) {
      if (done) {
        clearTimeout(timer)
        return
      }
      done = true
      clearTimeout(timer)
      resolve({ ms: performance.now() - t0, ip: null, error: (err as NodeJS.ErrnoException)?.code || 'error' })
    }
  })
}

function timedTcpConnect(ip: string, port: number, timeoutMs: number): Promise<StageResult> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    let settled = false
    const finish = (ok: boolean, error: string | null) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      resolve({ ms: performance.now() - t0, ok, error })
    }
    // connect to a literal IP so DNS is entirely out of the path; a network
    // blackhole shows here as a bare SYN timeout with no bytes exchanged.
    const socket = netConnect({ host: ip, port, family: 4 })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true, null))
    socket.once('timeout', () => finish(false, 'timeout'))
    socket.once('error', (err: NodeJS.ErrnoException) => finish(false, err.code || err.name || 'error'))
  })
}

// Bounded TLS handshake to (ip, port) presenting `servername` as SNI. SNI-based
// filtering surfaces here as a reset/hang AFTER a clean SYN, distinguishing it
// from a network blackhole (which fails at SYN) and from a healthy path.
function timedTlsHandshake(ip: string, port: number, servername: string, timeoutMs: number): Promise<StageResult> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    let settled = false
    let socket: ReturnType<typeof tlsConnect> | undefined
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs)
    function finish(ok: boolean, error: string | null) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.destroy()
      } catch {
        /* ignore */
      }
      resolve({ ms: performance.now() - t0, ok, error })
    }
    try {
      // Connect to the literal IP but present the real hostname as SNI. We only
      // care whether the handshake COMPLETES, not whether the cert validates, so
      // rejectUnauthorized:false keeps a cert mismatch (we're dialing an IP) from
      // masking the SNI-filter signal we're actually testing for.
      socket = tlsConnect({ host: ip, port, servername, rejectUnauthorized: false }, () => finish(true, null))
      socket.once('error', (err: NodeJS.ErrnoException) => finish(false, err.code || err.name || 'error'))
    } catch (err) {
      finish(false, (err as NodeJS.ErrnoException)?.code || 'error')
    }
  })
}

async function diagnoseBlackhole(url: string): Promise<BlackholeStageDiag | null> {
  let host: string
  let port: number
  try {
    const u = new URL(url)
    host = u.hostname
    port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
  // Stage 1: resolve DNS for the real host (time-bounded). A hang here means the
  // round's `timeout` was a DNS stall.
  const dns = await timedDnsLookup(host, 3000)

  // Stage 2a: raw SYN to a STATIC mainland IP literal — NO DNS in the path, so
  // this runs even when stage 1 hung. This is the decisive network-vs-DNS test:
  // if this SYN times out, the egress path to the mainland is blackholed; if it
  // connects while DNS failed, the failure was the resolver.
  let synStatic: StageResult = { ms: null, ok: false, error: 'no-literal' }
  let synStaticIp = MAINLAND_IP_LITERALS[0] ?? ''
  for (const ip of MAINLAND_IP_LITERALS) {
    synStaticIp = ip
    synStatic = await timedTcpConnect(ip, 443, 3000)
    if (synStatic.ok) break // a reachable literal is enough
  }

  // Stage 2b: raw SYN to the DNS-resolved IP (only if DNS gave one) for a direct
  // comparison against the same host the round actually tried.
  let synResolved: StageResult = { ms: null, ok: false, error: 'skipped-no-ip' }
  if (dns.ip) synResolved = await timedTcpConnect(dns.ip, port, 3000)

  // Stage 3: bounded TLS handshake with the real SNI, over whichever IP just
  // connected at the TCP layer (prefer the resolved host's IP; fall back to the
  // static literal). Only meaningful if some SYN succeeded.
  let tls: StageResult = { ms: null, ok: false, error: 'skipped-no-syn' }
  const tlsIp = synResolved.ok && dns.ip ? dns.ip : synStatic.ok ? synStaticIp : null
  if (tlsIp) tls = await timedTlsHandshake(tlsIp, 443, host, 3000)

  return {
    host,
    dnsMs: Math.round(dns.ms),
    dnsOk: dns.ip !== null,
    dnsError: dns.error,
    resolvedIp: dns.ip,
    synStaticIp,
    synStaticMs: synStatic.ms === null ? null : Math.round(synStatic.ms),
    synStaticOk: synStatic.ok,
    synStaticError: synStatic.error,
    synResolvedMs: synResolved.ms === null ? null : Math.round(synResolved.ms),
    synResolvedOk: synResolved.ok,
    synResolvedError: synResolved.error,
    tlsMs: tls.ms === null ? null : Math.round(tls.ms),
    tlsOk: tls.ok,
    tlsError: tls.error,
  }
}

export type { ProbeResult, ProbeSnapshot } from './probe-snapshot'

const MAX_BODY_BYTES = 64 * 1024
// Keep six requests per target to bound round duration / serverless GB-seconds.
// Require three successes even though we report the fastest measured response.
const SAMPLE_COUNT = 4
const MIN_SAMPLES = 3
const WARMUP_COUNT = 2
// Trim only the default timeout (5s→3s): a healthy target answers well under it
// (the farthest real paths, e.g. Seoul→São Paulo, sit ~300ms), so 3s still leaves
// a 10× margin while stopping dead targets from stalling a round for 5s each.
const DEFAULT_TIMEOUT_MS = 3000
// China now uses the same 3s timeout as everything else. It was 2s, but that was
// TOO TIGHT: the first cross-border TCP+TLS handshake into China costs 0.4-1.4s
// from AWS Seoul/Singapore (Beijing ~1.4s ≈ one dropped SYN + Linux's 1s SYN
// retransmit), and in-round fan-out CPU parking (80-300ms) pushed it past 2s,
// producing FALSE timeouts on reachable endpoints (they return 403, and warm
// samples run ~100ms). 3s absorbs the cold handshake with margin while warm
// samples are unaffected (min() reports the fast warm read regardless of the
// abort ceiling). Fail-fast (all-warmups-fail → bail) bounds a genuinely dead
// China target to 2×3s, and the original 5s→3s trim already removed the long
// stalls the 2s bucket was created to avoid. Cross-reviewed (claude+antigravity),
// unanimous. Applies uniformly to the main round and both follow-up passes.
const CHINA_TIMEOUT_MS = 3000
// The FIRST request to a target gets a longer cold-connect budget; every later
// request (the 2nd warmup and all timed samples) keeps the per-target timeout.
// On the longest real paths (Tokyo/Sydney/Australia → Oracle Valparaíso, ~380ms
// warm RTT) the first TCP+TLS handshake measured ~5.5s (≈3-4 RTTs across a
// >25,000km trans-Pacific route + SYN-retransmit backoff), so both 3s warmups
// aborted and fail-fast blanked a reachable cell whose steady-state latency is
// ~380ms. Only the first attempt pays this: a dead target now costs 7s+3s (was
// 2×3s), far cheaper than raising the timeout uniformly (which would be 2×7s and
// would need ≥7s to even cover 5.5s, since an aborted handshake destroys the
// socket and the next attempt is cold again). Warmups aren't timed into the
// reported ms, and samples stay at 3s (a mid-round reconnect measured ~2.2s and
// MIN_SAMPLES tolerates one aborted sample), so no measured value changes.
// Cross-reviewed (claude + antigravity), unanimous on first-request-only @ 7s.
const COLD_CONNECT_TIMEOUT_MS = 7000
// The implausible-sample floor (MIN_PLAUSIBLE_MS) is shared with the browser
// vantage point via measure-core: samples faster than it are dropped before
// min() so one sub-RTT artifact can't win outright. MIN_SAMPLES already
// tolerates dropping a sample.

// --- Near-cell serial re-measure pass ---------------------------------------
// Confirmed by spin-probe instrumentation: the concurrent fan-out intermittently
// parks the process on the CPU quota (spinWorstInflation 4-5x, parks 80-150ms),
// and that scheduling wait is absorbed into performance.now() elapsed. It adds a
// roughly FIXED number of ms, so it barely dents far cells (300ms) but inflates
// near cells (true 3-30ms) by 2-6x — visible in history as a low min with a max
// several times higher. Fix: after the pool drains, re-measure the nearest cells
// SERIALLY (no fan-out => no parking, same principle as the self-cell fix) and
// keep min(pool, serial) since parking only ever inflates.
const NEAR_CELL_THRESHOLD_MS = 60
// We re-measure EVERY near cell (no early budget cutoff): the accuracy of small
// values matters and the cost is tiny (~123ms/cell; even the densest origin,
// ~78 sub-40ms neighbours in Europe, adds only ~9s/round ≈ +$0.16/month over the
// whole fleet). Only a generous SAFETY cap remains to protect against a
// pathological round (e.g. a flood of slow near cells) hitting the Lambda's
// hard timeout — it is far above any normal pass and should never trigger.
const REMEASURE_SAFETY_CAP_MS = 120_000
// Lighter than the pool's 2+4: the pool just left a warm keep-alive socket, so 1
// warmup + 3 timed re-establishes/confirms it and still meets MIN_SAMPLES=3.
const REMEASURE_WARMUP = 1
const REMEASURE_SAMPLES = 3
// The self-cell (origin's own region) is measured on its own after the pool, not
// in the fan-out and not gated on any threshold. It's the value most inflated by
// CPU parking relative to its true ~2-3ms, so it gets the full 2 warmup + 4 timed
// treatment for the best chance at a clean minimum.
const SELF_WARMUP = 2
const SELF_SAMPLES = 4
// Idle gap between the pool draining and the serial measurements. On the ~0.28
// vCPU Lambda the pool can leave the current CFS quota window (~100ms period)
// near-exhausted, plus libuv socket teardown / V8 GC from the 344-cell fan-out is
// still queued. Yielding one quota period before the uncontended serial pass lets
// that drain so the first serial samples aren't parked by the pool's tail. Costs
// ~100ms wall (~0.2% of a round), ~0 CPU.
const POST_POOL_SETTLE_MS = 100

// Tracks whether a round has already entered this module instance. This is a
// proxy, not proof: it only says "a prior runProbe() call started here", not
// that the platform did (or didn't) pay a cold-start / network-path-init cost.
let warmContainer = false

type SelfProbeStatus = 'ok' | 'failed' | 'unavailable' | 'round-failed'

// A single self-cell sample: measured ms plus whether this request opened a new
// TCP+TLS connection (true) or reused a warm socket (false). `newConn` is
// undefined only if the diagnostics channel was unavailable.
type SelfSample = { ms: number; newConn?: boolean }

// Best-effort structured log. Never let a logging failure (or JSON.stringify
// throwing on unexpected input) mask the round's real outcome.
function logSelfProbe(fields: {
  origin: string
  warmContainer: boolean
  status: SelfProbeStatus
  ms: number | null
  samples: number | null
  error: 'timeout' | 'network' | null
  raw?: SelfSample[] | null
}): void {
  try {
    console.log(JSON.stringify({ kind: 'self-probe', ...fields }))
  } catch {
    /* logging must never affect the round's result or rejection */
  }
}

function isChinaTarget(country: string, url: string): boolean {
  if (country === 'CN') return true
  return /(?:\.cn(?:[:/]|$)|amazonaws\.com\.cn|oss-cn-)/i.test(url)
}

async function drainAfterClock(res: Response): Promise<void> {
  const body = res.body
  if (!body) {
    await res.arrayBuffer().catch(() => undefined)
    return
  }
  const reader = body.getReader()
  let n = 0
  try {
    for (;;) {
      // If the request's abort timer fires mid-drain (a target that sent headers
      // then stalls the body), reader.read() rejects with AbortError; we swallow
      // it — the latency clock already stopped at headers, so a truncated drain
      // doesn't affect the measurement, it just frees the socket promptly.
      const { done, value } = await reader.read()
      if (done) return
      n += value?.byteLength || 0
      if (n >= MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        return
      }
    }
  } catch {
    await reader.cancel().catch(() => undefined)
  }
}

async function timedGet(url: string, timeoutMs: number): Promise<{ ms: number; newConn?: boolean }> {
  const target = withCacheBuster(url)
  // Host to attribute connection events to. undici reports the hostname (no
  // port) in connectParams; parsing failure just disables newConn for this
  // sample rather than throwing.
  let host: string | undefined
  try {
    host = new URL(target).hostname
  } catch {
    host = undefined
  }
  // Snapshot the per-host new-connection counter before the request. Within a
  // target's worker, samples run strictly sequentially (one request in flight
  // to this host at a time), so any increase during this fetch is attributable
  // to THIS request — an exact reused-vs-fresh signal, not a heuristic.
  const connBefore = host ? (connectCountByHost.get(host) ?? 0) : 0
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = performance.now()
  try {
    const res = await fetch(target, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'cloudping.me-probe' },
    })
    const elapsed = performance.now() - start
    // Keep the abort timer ARMED through the drain: the latency clock has already
    // stopped (elapsed captured at response headers), but a target that sends
    // headers then stalls the body would otherwise hold this socket until
    // undici's default 300s bodyTimeout. Letting the same timer abort the drain
    // frees the slot within timeoutMs. The finally clears it once drain returns.
    await drainAfterClock(res)
    // Compare the counter after headers arrived: a fresh socket for this request
    // increments it, a reused one leaves it unchanged. undefined host → unknown.
    const newConn = host ? (connectCountByHost.get(host) ?? 0) > connBefore : undefined
    // performance.now() is monotonic, so elapsed can't go negative; the clamp is
    // a cheap defensive floor, not a correction for clock step-backs.
    return { ms: Math.max(elapsed, 0), newConn }
  } finally {
    clearTimeout(timer)
  }
}

function errorKind(err: unknown): 'timeout' | 'network' {
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError') return 'timeout'
  return 'network'
}

async function pingTarget(
  url: string,
  timeoutMs: number,
  opts?: { warmupCount?: number; sampleCount?: number }
): Promise<{ ms: number; samples: number; raw: SelfSample[] } | { error: 'timeout' | 'network' }> {
  // Warmup/sample counts default to the full pool values but can be trimmed for
  // the serial near-cell re-measure pass: that pass runs after the pool, when
  // the keep-alive socket is usually still warm, so 1 warmup + 3 timed suffices
  // (MIN_SAMPLES stays 3) — ~33% cheaper per re-measured cell.
  const warmupCount = opts?.warmupCount ?? WARMUP_COUNT
  const sampleCount = opts?.sampleCount ?? SAMPLE_COUNT
  // Warm up the connection (DNS, TLS session, and the target's own cold start)
  // with throwaway requests so the timed samples reflect steady-state latency
  // rather than first-hit cost. Individual warmup failures are tolerated, but
  // if *every* warmup fails we treat the target as down and bail out below
  // rather than spending the full sample budget on timeouts.
  let warmupOk = 0
  let warmupError: 'timeout' | 'network' = 'network'
  for (let i = 0; i < warmupCount; i++) {
    try {
      // First contact may cross the longest paths' cold-connect cost (~5.5s);
      // give only it the COLD_CONNECT budget, later requests keep timeoutMs.
      await timedGet(url, i === 0 ? Math.max(timeoutMs, COLD_CONNECT_TIMEOUT_MS) : timeoutMs)
      warmupOk++
    } catch (err) {
      warmupError = errorKind(err)
    }
  }

  // Fail fast: if every warmup attempt failed, the target is down or
  // unreachable from here. Don't spend SAMPLE_COUNT more timeouts (each up to
  // timeoutMs) confirming it — a slow/dead region should drop out of the round
  // quickly. A region that is merely slow still answers warmups, so this only
  // short-circuits genuine failures.
  if (warmupOk === 0) return { error: warmupError }

  // `samples` holds the plausible per-sample timings (used for min()); `raw`
  // pairs each with its newConn flag so the self-probe log can show, per sample,
  // whether a slow reading coincided with a fresh TCP+TLS handshake.
  const samples: number[] = []
  const raw: SelfSample[] = []
  let lastError: 'timeout' | 'network' = warmupError
  for (let i = 0; i < sampleCount; i++) {
    try {
      const { ms, newConn } = await timedGet(url, timeoutMs)
      // Drop implausibly-fast readings so a single artifact can't win min().
      if (ms >= MIN_PLAUSIBLE_MS) {
        samples.push(ms)
        raw.push({ ms: Math.round(ms), ...(newConn === undefined ? {} : { newConn }) })
      }
    } catch (err) {
      lastError = errorKind(err)
    }

    // Once the remaining attempts cannot bring us to MIN_SAMPLES, the result
    // is already known to be a failure. Avoid up to two more doomed requests;
    // this preserves the existing success rule while reducing socket churn and
    // worst-case round duration on constrained probe origins.
    const remaining = sampleCount - i - 1
    if (samples.length + remaining < MIN_SAMPLES) break
  }
  if (samples.length < MIN_SAMPLES) return { error: lastError }
  // Queueing and event-loop stalls add delay. The minimum estimates the least
  // congested HTTP round trip, still including target processing (not raw RTT).
  // Report whole milliseconds — sub-ms precision isn't meaningful for these paths
  // and keeps the /health table clean. `raw` carries the individual per-sample
  // timings + newConn flag so the self-probe log can expose their shape: a
  // bimodal set where the slow samples have newConn:true confirms intermittent
  // TCP+TLS handshake cost; slow samples with newConn:false point instead at
  // CPU/scheduling delay on the constrained Lambda vCPU (elapsed absorbing a
  // parked process even on a warm socket).
  return { ms: Math.round(Math.min(...samples)), samples: samples.length, raw }
}

async function mapPool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function run(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await worker(items[i])
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: n }, () => run()))
  return out
}

export async function runProbe(concurrency = 24): Promise<ProbeSnapshot> {
  // Claim (and flip) the warm-state flag as the very first statement, before
  // any other work — setup (data lookups, job construction, origin
  // resolution) as well as measurement. This guarantees two properties:
  // 1. Two rounds that overlap in this module instance can't both read
  //    `false`: whichever call reaches this line first "wins" cold, every
  //    later one is warm no matter how their awaits interleave.
  // 2. The flag advances for every *attempted* round, even one that never
  //    reaches the pool, so a setup failure can't leave the next round
  //    wrongly marked cold.
  const warmAtEntry = warmContainer
  warmContainer = true

  // `origin` is resolved inside the try below; a fallback id is used for the
  // failure diagnostic if the exception happens before resolution completes.
  let origin: { id: string; label: string } | undefined

  // Per-sample timings of the self-cell (origin measuring its own region), filled
  // in measureJob once origin is known. Diagnostic only — surfaced in the
  // self-probe log to test the connection-reuse-failure hypothesis for AWS self
  // jitter. Reset each round via the module-scope declaration below.
  let selfRaw: SelfSample[] | null = null

  try {
    const started = Date.now()
    const providers = getAllProviders()
    const regions = getAllCloudRegions()
    const jobs: { provider: string; region: (typeof regions)[string][number]; recheck: boolean }[] = []
    for (const provider of providers) {
      for (const region of regions[provider.key] || []) {
        if (!region.ping_url) continue
        // probe_disabled regions are officially-operated regions whose public
        // endpoint normally rate-limits/blocks datacenter traffic. We still
        // probe them every round (marked recheck:true) so they auto-recover if
        // the endpoint starts accepting traffic again — a successful round shows
        // real values, and a failed one stays ok:false like any other failure
        // (so it keeps its slot in the 7-day history and doesn't reset the
        // series). Fail-fast in pingTarget keeps a still-dead recheck cheap.
        jobs.push({ provider: provider.key, region, recheck: !!region.probe_disabled })
      }
    }

    const measureJob = async (job: (typeof jobs)[number]): Promise<ProbeResult> => {
      const timeoutMs = isChinaTarget(job.region.country, job.region.ping_url) ? CHINA_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
      const base: ProbeResult = {
        provider: job.provider,
        region: job.region.key,
        location: job.region.location,
        country: job.region.country,
        geo: job.region.geo,
        ms: null,
        ok: false,
      }
      const out = await pingTarget(job.region.ping_url, timeoutMs)
      if ('error' in out) return { ...base, error: out.error }
      return { ...base, ms: out.ms, ok: true, samples: out.samples }
    }

    origin = resolveOrigin()

    // Kick off the egress-IP lookup now so it overlaps the whole measurement
    // pass (its result is only read when we build the round summary). Fire-and-
    // forget: lookupEgressIp swallows all errors and resolves to null, so this
    // never rejects and never needs its own try/catch. We sample it AGAIN at
    // round end (egressIpEnd) so the summary can self-check IP stability: a
    // non-VPC Lambda/Cloud Run/App Service has no guaranteed fixed egress, and a
    // per-connection NAT could in principle send the checkip request and the
    // mainland requests out different addresses (raised in review). If the two
    // samples disagree (egressIpStable:false) the per-round IP↔blackhole pairing
    // is unreliable for that round and the cross-round correlation must account
    // for it; if they consistently agree, the single value is trustworthy.
    const egressIpPromise = lookupEgressIp()

    // Exclude the self-cell (origin measuring its own region) from the concurrent
    // fan-out entirely and measure it alone after the pool (see the serial pass
    // below). On the ~0.28 vCPU Lambda, running self among 12 concurrent targets
    // means ~half of rounds its samples get CPU-parked to 40-300ms; a pooled self
    // reading is never trustworthy, so there's no point spending 6 requests on it
    // in the most congested phase. This restores the #63 guarantee that #66/#67
    // accidentally regressed (folding self into a pool-value-gated near-cell set
    // let a parked self fall above the threshold and never get re-measured).
    const selfIndex = jobs.findIndex((j) => `${j.provider}-${j.region.key}` === origin!.id)
    const poolJobs = selfIndex >= 0 ? jobs.filter((_, i) => i !== selfIndex) : jobs

    // Instrument event-loop lag across the whole measurement pass. If the leading
    // hypothesis is right (fan-out TLS/socket callbacks starving the small Lambda's
    // ~0.15 vCPU so performance.now() elapsed absorbs scheduling delay), this shows
    // multi-ms/second stalls that correlate with inflated per-cell mins. Near-zero
    // lag on a round would instead point the finger at target-side variance. The
    // histogram itself is cheap (libuv timer sampling) and adds no probe requests.
    const eld = monitorEventLoopDelay({ resolution: 20 })
    eld.enable()
    // Measure CPU starvation across the fan-out (see the diagnostic helpers up
    // top). process.cpuUsage() + wall clock around the pool give a utilization
    // ratio; the optional spin sampler adds direct per-probe wall/cpu inflation.
    // The spin sampler is OFF by default: it burns ~3M iterations every 50ms,
    // which is ~15-20% of the 512MB Lambda's CFS quota and actively worsens the
    // very parking it measures. It already proved the CPU-parking thesis (#65),
    // so gate it behind PROBE_CPU_DIAGNOSTIC=1 for one-off investigations only.
    const cpuBefore = process.cpuUsage()
    const wallBefore = performance.now()
    const spinEnabled = process.env.PROBE_CPU_DIAGNOSTIC === '1'
    let poolDone = false
    let spinWorstInflation = 1
    let spinSamples = 0
    let spinMaxWallMs = 0
    const spinSampler = spinEnabled
      ? (async () => {
          const ITER = 3_000_000
          while (!poolDone && spinSamples < 200) {
            const { wallMs, cpuMs } = spinOnce(ITER)
            spinSamples++
            if (cpuMs > 0.05) spinWorstInflation = Math.max(spinWorstInflation, wallMs / cpuMs)
            spinMaxWallMs = Math.max(spinMaxWallMs, wallMs)
            await new Promise((r) => setTimeout(r, 50))
          }
        })()
      : Promise.resolve()
    const poolResults = await mapPool(poolJobs, concurrency, measureJob)
    poolDone = true
    await spinSampler
    const cpuDelta = process.cpuUsage(cpuBefore)
    const poolWallMs = performance.now() - wallBefore
    eld.disable()

    // Settle gap: let the pool's socket teardown / GC drain and the CFS quota
    // window roll over before the uncontended serial measurements, so the first
    // serial samples aren't parked by the fan-out's tail.
    await new Promise((r) => setTimeout(r, POST_POOL_SETTLE_MS))

    // Measure the self-cell ALONE, serially, unconditionally (never threshold-
    // gated). Full 2 warmup + 4 timed on the quiet loop for the cleanest minimum.
    // Computed BEFORE assembling `results` so the array is never in a partial
    // state (no null placeholder to leak on an unexpected throw).
    let selfCellResult: ProbeResult | undefined
    if (selfIndex >= 0) {
      const selfJob = jobs[selfIndex]
      const base: ProbeResult = {
        provider: selfJob.provider,
        region: selfJob.region.key,
        location: selfJob.region.location,
        country: selfJob.region.country,
        geo: selfJob.region.geo,
        ms: null,
        ok: false,
      }
      const timeoutMs = isChinaTarget(selfJob.region.country, selfJob.region.ping_url) ? CHINA_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
      const out = await pingTarget(selfJob.region.ping_url, timeoutMs, { warmupCount: SELF_WARMUP, sampleCount: SELF_SAMPLES })
      if ('error' in out) {
        selfCellResult = { ...base, error: out.error }
      } else {
        selfRaw = out.raw
        selfCellResult = { ...base, ms: out.ms, ok: true, samples: out.samples }
      }
    }

    // Reassemble catalog order: poolResults covers every non-self job in order,
    // so splicing the (fully-measured) self result back at selfIndex restores the
    // original indexing (position-based round diagnostics and snapshot column
    // order stay stable). No transient null entry ever exists in `results`.
    const results: ProbeResult[] =
      selfIndex >= 0 && selfCellResult ? [...poolResults.slice(0, selfIndex), selfCellResult, ...poolResults.slice(selfIndex)] : [...poolResults]

    // --- Near-cell serial re-measure pass (off-diagonal) --------------------
    // The self-cell is already measured serially above. Now refine the OTHER near
    // cells that rode the concurrent fan-out, where CPU parking inflates small
    // values. Re-measure serially on the now-quiet loop and keep min(pool,serial):
    // parking only inflates, so the lower reading is the more accurate one.
    //
    // A cell is a candidate if its pool ms is below the threshold OR it's in the
    // same country as the origin (a geographic prior). The country prior is the
    // key fix for the #66/#67 regression: parking can inflate a truly-near cell's
    // pool value ABOVE the threshold, which would wrongly exclude it from the very
    // pass meant to correct it. Static catalog geography can't be inflated, so a
    // same-country cell (e.g. AWS Seoul → GCP Seoul) is always re-measured. Far
    // cells are left untouched: a fixed ~tens-of-ms park is noise on a 150ms+ path.
    const originCountry = selfIndex >= 0 ? jobs[selfIndex].region.country : undefined
    const nearIdx = results
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) => {
        if (i === selfIndex) return false // already measured serially above
        if (!r.ok || typeof r.ms !== 'number') return false
        return r.ms < NEAR_CELL_THRESHOLD_MS || (!!originCountry && r.country === originCountry)
      })
      .sort((a, b) => (a.r.ms as number) - (b.r.ms as number))
      .map(({ i }) => i)

    let remeasured = 0
    let remeasureImproved = 0
    let remeasureCappedOut = false
    const remeasureStart = performance.now()
    for (const i of nearIdx) {
      // Safety cap only: normally every near cell is re-measured. This guards a
      // pathological round from approaching the Lambda hard timeout; it should
      // never fire in practice (densest origin ≈ 9s << cap).
      if (performance.now() - remeasureStart >= REMEASURE_SAFETY_CAP_MS) {
        remeasureCappedOut = true
        break
      }
      const job = jobs[i]
      const timeoutMs = isChinaTarget(job.region.country, job.region.ping_url) ? CHINA_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
      const out = await pingTarget(job.region.ping_url, timeoutMs, { warmupCount: REMEASURE_WARMUP, sampleCount: REMEASURE_SAMPLES })
      remeasured++
      // Serial failure keeps the pool value (don't fail a cell that succeeded in
      // the pool); success takes the min so parking inflation is removed.
      if (!('error' in out)) {
        const pooled = results[i].ms as number
        if (out.ms < pooled) {
          remeasureImproved++
          results[i] = { ...results[i], ms: out.ms, samples: out.samples }
        }
      }
    }
    const remeasureSpentMs = Number((performance.now() - remeasureStart).toFixed(0))

    const eldStats = {
      // Nanoseconds → milliseconds. `max`/`p99` are the tell: a healthy event loop
      // stays sub-millisecond; tens-to-hundreds of ms means the loop stalled.
      meanMs: Number((eld.mean / 1e6).toFixed(2)),
      maxMs: Number((eld.max / 1e6).toFixed(2)),
      p99Ms: Number((eld.percentile(99) / 1e6).toFixed(2)),
    }
    // CPU-starvation summary for the pool phase. This is the direct test of the
    // near-cell-inflation root cause now that cgroup stats are unavailable:
    //   cpuUtil    = CPU seconds burned / wall seconds. Near a ~0.28 vCPU cap
    //                under compute pressure it presses toward that ceiling.
    //   spinWorstInflation = worst wall/cpu ratio of a fixed spin running
    //                alongside the fan-out; >> 1 means the process was parked
    //                mid-spin (throttling/contention) — the smoking gun.
    // If spinWorstInflation is large (e.g. 10-40x) the inflation IS CPU parking,
    // so a calmer serial re-measure of near cells is the fix. Near-1 would refute
    // it. cpuMs and wall are included so the numbers are auditable.
    const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000
    const cpuStarvation = {
      cpuMs: Number(cpuMs.toFixed(1)),
      wallMs: Number(poolWallMs.toFixed(1)),
      cpuUtil: poolWallMs > 0 ? Number((cpuMs / poolWallMs).toFixed(3)) : null,
      spinSamples,
      spinWorstInflation: Number(spinWorstInflation.toFixed(1)),
      spinMaxWallMs: Number(spinMaxWallMs.toFixed(1)),
    }

    // Observability for the near-cell serial re-measure pass: how many near cells
    // there were, how many we re-measured (normally all of them), how many the
    // serial reading improved (min beat the pool value), the wall time it cost,
    // and whether the safety cap fired (should always be false). `selfMs` is the
    // self-cell's final (serially-measured) value, surfaced here so a future
    // self regression is visible in one line without cross-referencing.
    const selfMsFinal = selfIndex >= 0 ? (results[selfIndex]?.ms ?? null) : null
    const nearCellRemeasure = {
      candidates: nearIdx.length,
      remeasured,
      improved: remeasureImproved,
      spentMs: remeasureSpentMs,
      cappedOut: remeasureCappedOut,
      selfMs: selfMsFinal,
    }

    // Observability for probe_disabled recovery: how many rechecks we attempted
    // and how many came back alive this round. Lets an operator see when such a
    // region has recovered (and its flag can be dropped) without scanning cells.
    const recheckJobs = jobs.filter((j) => j.recheck)
    const recheckAttempted = recheckJobs.length
    const recheckRecovered = results.filter((r) => r.ok && recheckJobs.some((j) => j.provider === r.provider && j.region.key === r.region)).length
    const failedTargets: Array<{ index: number; provider: string; region: string; error: string }> = []
    const failureKinds: Record<string, number> = {}
    let failedCount = 0
    let firstFailedIndex: number | null = null
    let lastFailedIndex: number | null = null
    let currentFailureBlock = 0
    let longestFailureBlock = 0

    results.forEach((result, index) => {
      if (result.ok) {
        currentFailureBlock = 0
        return
      }
      const error = result.error || 'unknown'
      failedCount++
      firstFailedIndex ??= index
      lastFailedIndex = index
      failureKinds[error] = (failureKinds[error] || 0) + 1
      currentFailureBlock++
      longestFailureBlock = Math.max(longestFailureBlock, currentFailureBlock)
      if (failedTargets.length < 50) {
        failedTargets.push({ index, provider: result.provider, region: result.region, error })
      }
    })

    // --- China mainland-reachability detector (diagnostic only) -------------
    // True when the round attempted mainland-China targets, ALL of them failed,
    // and at least one Hong Kong control succeeded. That shape localizes the
    // problem to the mainland path specifically: a process-wide CPU park or a
    // local origin-wide network fault would also take Hong Kong down, so an
    // all-mainland-down / HK-up round points at something on the origin→mainland
    // route rather than the origin itself. It does NOT by itself prove WHICH
    // network drops the traffic (GFW blocklist, transit loss, source-prefix
    // filtering, congestion are all consistent) — the stage diagnostic below
    // (DNS vs raw SYN vs TLS) narrows the failing LAYER, and egressIp records
    // the source address, but attribution to a specific operator stays
    // suspected, not proven. Kept as observational signal, not a causal verdict.
    const mainlandResults = results.filter(isMainlandChina)
    const hkResults = results.filter(isHongKong)
    const mainlandOk = mainlandResults.filter((r) => r.ok).length
    const hkOk = hkResults.filter((r) => r.ok).length
    const cnBlackhole = mainlandResults.length > 0 && mainlandOk === 0 && hkOk > 0

    // On a blackhole round only, run the stage-separating diagnostic against one
    // mainland host (DNS timing/result + a raw SYN to the resolved IP literal)
    // to observe whether the `timeout` is a network blackhole, a DNS stall, or
    // SNI/TLS filtering — the observation that picks the next fix. Never runs on
    // healthy rounds, so it adds no steady-state cost; fully wrapped so it can
    // neither fail nor materially slow the round.
    let blackholeStage: BlackholeStageDiag | null = null
    if (cnBlackhole && mainlandResults.length > 0) {
      // Map the first mainland result back to its job to recover the ping_url.
      const firstMainland = mainlandResults[0]
      const mlJob = jobs.find((j) => j.provider === firstMainland.provider && j.region.key === firstMainland.region)
      if (mlJob?.region.ping_url) {
        try {
          blackholeStage = await diagnoseBlackhole(mlJob.region.ping_url)
        } catch {
          blackholeStage = null
        }
      }
    }

    // The egress-IP lookup was fired at round start; it resolves to a validated
    // IPv4 string or null (never rejects). Awaiting here adds no latency in
    // practice — it has had the entire pool duration to complete. Sample again
    // now (round end) to self-check stability across the round: egressIpStable
    // is true only when both samples resolved AND matched. When it's false the
    // platform is choosing outbound addresses per-connection/per-time, so a
    // single egressIp cannot be assumed to be the address the mainland requests
    // used — the correlation analysis must treat those rounds with caution.
    const [egressIp, egressIpEnd] = await Promise.all([egressIpPromise, lookupEgressIp()])
    const egressIpStable = egressIp !== null && egressIpEnd !== null ? egressIp === egressIpEnd : null

    // Shared topology log for AWS, GCP, Azure, and Vercel origins. Keeping the
    // catalog index and target identity distinguishes destination-specific
    // failures from an origin-side resource block without another probe pass.
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        kind: 'probe-round-summary',
        origin: origin.id,
        egressIp,
        egressIpEnd,
        egressIpStable,
        concurrency,
        durationMs: Date.now() - started,
        eventLoopDelay: eldStats,
        cpuStarvation,
        nearCellRemeasure,
        cells: results.length,
        failed: failedCount,
        cnBlackhole,
        chinaMainland: { attempted: mainlandResults.length, ok: mainlandOk },
        hongKong: { attempted: hkResults.length, ok: hkOk },
        blackholeStage,
        firstFailedIndex,
        lastFailedIndex,
        longestFailureBlock,
        failureKinds,
        failedTargets,
        failedTargetsTruncated: failedCount - failedTargets.length,
        recheckAttempted,
        recheckRecovered,
      })
    )

    // Self was measured serially after the pool drained (see the self-LAST
    // rationale above), then spliced back at its catalog index. This diagnostic
    // records the post-pass value and warmContainer so the accuracy of the
    // uncontended measurement can be tracked on live rounds (and split cold vs
    // warm to confirm the startup-CPU story behind the reverted self-first pass).
    const selfResult = results.find((r) => `${r.provider}-${r.region}` === origin!.id)
    if (!selfResult) {
      logSelfProbe({ origin: origin.id, warmContainer: warmAtEntry, status: 'unavailable', ms: null, samples: null, error: null })
    } else if (selfResult.ok) {
      logSelfProbe({
        origin: origin.id,
        warmContainer: warmAtEntry,
        status: 'ok',
        ms: selfResult.ms,
        samples: selfResult.samples ?? null,
        error: null,
        raw: selfRaw,
      })
    } else {
      logSelfProbe({ origin: origin.id, warmContainer: warmAtEntry, status: 'failed', ms: null, samples: null, error: selfResult.error ?? null })
    }

    return {
      probe: {
        id: origin.id,
        label: origin.label,
        at: new Date().toISOString(),
        durationMs: Date.now() - started,
      },
      results,
    }
  } catch (err) {
    // Setup (data lookups, job construction, origin resolution) or the pool
    // itself rejected — not an individual target failure, those are caught
    // inside pingTarget/measureJob and reported as a normal ProbeResult.
    // Emit exactly one diagnostic for the round, then re-raise unchanged.
    logSelfProbe({ origin: origin?.id ?? 'unknown', warmContainer: warmAtEntry, status: 'round-failed', ms: null, samples: null, error: null })
    throw err
  }
}

/**
 * Decide the probe's origin id/label. The id becomes the /health column key, so
 * two origins that share an id silently overwrite each other when the workflow
 * merges their snapshots. Explicit PROBE_ORIGIN_ID/LABEL win; otherwise we derive
 * a distinct id from the runtime so a Vercel Function and an AWS Lambda never
 * collide even when the operator forgets to set them.
 */
function resolveOrigin(): { id: string; label: string } {
  const explicitId = process.env.PROBE_ORIGIN_ID
  const explicitLabel = process.env.PROBE_ORIGIN_LABEL
  if (explicitId) {
    return { id: explicitId, label: explicitLabel || explicitId }
  }

  // AWS Lambda always sets these; Vercel does not.
  const lambdaName = process.env.AWS_LAMBDA_FUNCTION_NAME
  if (lambdaName) {
    const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'unknown'
    return {
      id: `aws-${awsRegion}`,
      label: explicitLabel || `AWS Lambda (${awsRegion})`,
    }
  }

  // GCP Cloud Run sets K_SERVICE. The region isn't in the env, so PROBE_ORIGIN_ID
  // should be set at deploy time; GCP_REGION is a convenience fallback.
  if (process.env.K_SERVICE) {
    const gcpRegion = process.env.GCP_REGION || 'unknown'
    return {
      id: `gcp-${gcpRegion}`,
      label: explicitLabel || `GCP Cloud Run (${gcpRegion})`,
    }
  }

  // Azure App Service sets WEBSITE_SITE_NAME. REGION_NAME holds the display
  // region (e.g. "Australia East"); PROBE_ORIGIN_ID is set explicitly at deploy
  // time, so this is just a safety net.
  if (process.env.WEBSITE_SITE_NAME) {
    const azureRegion = (process.env.REGION_NAME || 'unknown').replace(/\s+/g, '').toLowerCase()
    return {
      id: `azure-${azureRegion}`,
      label: explicitLabel || `Azure App Service (${azureRegion})`,
    }
  }

  const vercelRegion = process.env.VERCEL_REGION || 'unknown'
  return { id: 'vercel', label: explicitLabel || `Vercel Function (${vercelRegion})` }
}
