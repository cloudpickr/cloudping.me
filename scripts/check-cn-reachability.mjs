// China mainland-reachability monitor.
//
// WHY: cloudping's China-mainland cells intermittently go all-blank from an AWS
// origin for a single 30-min round while the Hong Kong controls stay healthy —
// a mainland-path connectivity failure that the PR #81/#82 diagnostics localized
// to TCP connection establishment (DNS resolves, a raw SYN to a mainland IP
// literal times out), with the responsible network SUSPECTED (GFW / transit /
// source-prefix filtering) but not proven. A three-model review (claude,
// antigravity, codex) concluded: STOP touching probing code, accept that a
// blackhole round self-heals on the next round (the egress IP already churns
// every round), and DON'T reopen engineering work merely because another blank
// appears — reopen ONLY on specific triggers. This script watches for those
// triggers so a human doesn't have to tail logs, and files ONE tracking issue
// when one fires. It never edits data or config.
//
// TRIGGERS (from the codex review) that this script CAN judge from public data:
//   T1 (frequency): mainland-blackhole rounds exceed a rate threshold over the
//       rolling window — "the gap rate is higher than we're willing to accept".
//   T2 (stuck origin): an origin's mainland stays all-failed (HK still passing)
//       for N consecutive observed rounds — i.e. it STOPPED self-healing, the
//       signal that would justify a static-EIP / real fix.
//
// TRIGGERS T3 (DNS-ok + TCP-ok yet probe fails) and T4 (same egress IP with
// mixed outcomes) need the per-round CloudWatch `blackholeStage`/`egressIp`
// diagnostics, which are NOT in the public data and would require AWS creds in a
// public-repo scheduled job. Those are left to a human reading logs AFTER an
// issue fires; the issue body says so.
//
// DATA SOURCE: public status-branch latest.json — the CURRENT raw round, which
// includes every cell's ok/error (a blackhole shows as mainland cells ok:false
// while HK cells ok:true). No cloud creds.
//
// STATE: a small rolling log (cn-monitor.json on the status branch) of one entry
// per (round, origin) with mainland/HK counts, so consecutive-round and rate
// triggers can be evaluated across runs. Entries older than WINDOW_HOURS drop.
//
// OUTPUT: --json prints a machine summary the workflow uses to decide whether to
// open/refresh the tracking issue (hasProblem = any trigger fired). Exit 0
// unless the latest.json fetch/parse fails (then non-zero so real breakage
// surfaces).

const LATEST_URL = process.env.LATEST_URL || 'https://raw.githubusercontent.com/froguin/cloudping.me/status/latest.json'
const STATE_PATH = process.env.CN_MONITOR_STATE || 'cn-monitor.json'
const FETCH_TIMEOUT_MS = 20000

// Rolling window for both the state log and the frequency trigger.
const WINDOW_HOURS = 48
// T1: flag if the mainland-blackhole rate across all APAC-origin observations in
// the window is at or above this. ~20% is the observed baseline, so the alert
// threshold is set well above it to catch a genuine WORSENING, not the norm.
const FREQ_ALERT = 0.4
// T1 needs a minimum sample before a rate means anything.
const FREQ_MIN_OBS = 20
// T2: flag if a single origin's mainland is all-failed (HK healthy) for at least
// this many CONSECUTIVE observed rounds — the "stopped self-healing" signal.
const STUCK_CONSECUTIVE = 4

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

async function getJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function isMainland(r) {
  return r.country === 'CN' && r.location !== 'Hong Kong'
}
function isHongKong(r) {
  return r.country === 'HK' || r.location === 'Hong Kong'
}

// Reduce the current raw round into one record per origin with mainland/HK
// counts and a per-origin blackhole flag (mainland attempted, all failed, >=1 HK
// ok) — the same definition the probe uses for cnBlackhole.
function summarizeRound(latest) {
  const at = latest.at || new Date().toISOString()
  const ts = Date.parse(at)
  const out = []
  const from = latest.from || {}
  for (const [origin, round] of Object.entries(from)) {
    const results = (round && round.results) || []
    const mainland = results.filter(isMainland)
    const hk = results.filter(isHongKong)
    if (mainland.length === 0) continue
    const mainlandOk = mainland.filter((r) => r.ok).length
    const hkOk = hk.filter((r) => r.ok).length
    out.push({
      ts,
      at,
      origin,
      mainlandAttempted: mainland.length,
      mainlandOk,
      hkOk,
      hkAttempted: hk.length,
      blackhole: mainland.length > 0 && mainlandOk === 0 && hkOk > 0,
    })
  }
  return out
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { entries: [] }
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    return Array.isArray(s.entries) ? s : { entries: [] }
  } catch {
    return { entries: [] }
  }
}

function evaluate(entries) {
  const cutoff = Date.now() - WINDOW_HOURS * 3600 * 1000
  const win = entries.filter((e) => typeof e.ts === 'number' && e.ts >= cutoff)

  // T1: overall blackhole rate across all observations in the window.
  const total = win.length
  const blackholes = win.filter((e) => e.blackhole).length
  const rate = total > 0 ? blackholes / total : 0
  const freqFlagged = total >= FREQ_MIN_OBS && rate >= FREQ_ALERT

  // T2: per-origin trailing consecutive blackhole streak (most recent first).
  const byOrigin = new Map()
  for (const e of win) {
    if (!byOrigin.has(e.origin)) byOrigin.set(e.origin, [])
    byOrigin.get(e.origin).push(e)
  }
  const stuck = []
  for (const [origin, list] of byOrigin) {
    list.sort((a, b) => b.ts - a.ts) // newest first
    let streak = 0
    for (const e of list) {
      if (e.blackhole) streak++
      else break
    }
    if (streak >= STUCK_CONSECUTIVE) stuck.push({ origin, streak, lastAt: list[0].at })
  }

  // Per-origin rate breakdown for the issue body.
  const perOrigin = []
  for (const [origin, list] of byOrigin) {
    const b = list.filter((e) => e.blackhole).length
    // list.length is always >= 1 (entries only enter byOrigin via push), but guard
    // the division anyway so a future refactor can't emit NaN into the JSON.
    const rate = list.length > 0 ? Number((b / list.length).toFixed(2)) : 0
    perOrigin.push({ origin, observations: list.length, blackholes: b, rate })
  }
  perOrigin.sort((a, b) => b.rate - a.rate)

  return {
    windowHours: WINDOW_HOURS,
    observations: total,
    blackholes,
    rate: Number(rate.toFixed(3)),
    freqFlagged,
    freqThreshold: FREQ_ALERT,
    stuck,
    stuckThreshold: STUCK_CONSECUTIVE,
    perOrigin,
    hasProblem: freqFlagged || stuck.length > 0,
  }
}

async function main() {
  const wantJson = process.argv.includes('--json')
  const persist = process.argv.includes('--persist')

  const latest = await getJson(LATEST_URL)
  const newRecords = summarizeRound(latest)

  const state = loadState()
  // Append this round's records, de-duplicating by (origin, at) so re-running the
  // monitor on the same published round doesn't double-count.
  const seen = new Set(state.entries.map((e) => `${e.origin}\t${e.at}`))
  for (const r of newRecords) {
    const k = `${r.origin}\t${r.at}`
    if (!seen.has(k)) {
      state.entries.push(r)
      seen.add(k)
    }
  }
  // Trim to the window (+ small margin) so the state file stays tiny.
  const cutoff = Date.now() - (WINDOW_HOURS + 2) * 3600 * 1000
  state.entries = state.entries.filter((e) => typeof e.ts === 'number' && e.ts >= cutoff)

  if (persist) writeFileSync(STATE_PATH, JSON.stringify(state))

  const result = evaluate(state.entries)
  result.generatedAt = new Date().toISOString()
  result.roundAt = latest.at || null

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return
  }

  console.log('# China mainland-reachability monitor\n')
  console.log(
    `window: ${result.windowHours}h | observations: ${result.observations} | blackholes: ${result.blackholes} | rate: ${(result.rate * 100).toFixed(0)}%\n`
  )
  for (const o of result.perOrigin) {
    console.log(`  ${o.origin}: ${o.blackholes}/${o.observations} blackhole (${(o.rate * 100).toFixed(0)}%)`)
  }
  if (result.stuck.length) {
    console.log('\n⚠️  STUCK origins (mainland all-failed, HK healthy, consecutive):')
    for (const s of result.stuck) console.log(`    - ${s.origin}: ${s.streak} rounds, latest ${s.lastAt}`)
  }
  if (result.freqFlagged) {
    console.log(`\n⚠️  FREQUENCY: ${(result.rate * 100).toFixed(0)}% >= ${(result.freqThreshold * 100).toFixed(0)}% over ${result.windowHours}h`)
  }
  console.log(
    result.hasProblem
      ? '\nA reopen trigger fired — a human should reassess (see issue).'
      : '\nNo trigger fired. Intermittent single-round blackholes that self-heal are expected and stay quiet.'
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
