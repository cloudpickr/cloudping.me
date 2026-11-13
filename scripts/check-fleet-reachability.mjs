// Fleet reachability monitor — cross-fleet asymmetry detector.
//
// WHY: separate from the China monitor (which is GFW-specific: mainland vs a
// Hong Kong control), this catches a DIFFERENT class — an entire ORIGIN FLEET
// (all AWS, or all GCP, or all Azure regions) simultaneously failing to reach
// ONE target, while the OTHER fleets reach that same target fine. Observed
// example: at one probe round every reporting Azure origin timed out to Vultr
// Santiago (Chile) while all 13 AWS and 6 GCP origins reached it at 49-353ms;
// it self-healed the next round. A three-model review (claude/antigravity/codex)
// concluded: the right, credential-free signal is CROSS-FLEET AGREEMENT — the
// same target succeeding from the other two fleets is the natural control, so
// no designated per-continent control target is needed (a flaky control would
// poison the signal). Do NOT retry-probe (a blip self-heals by the next round and
// re-probing costs serverless compute); do NOT alert on a single round (that
// self-heals); only a persistent, confirmed asymmetry is worth a human.
//
// SIGNAL (per candidate = a (fleet F, target t) pair, in one accepted round):
//   valid iff F and both other fleets each have >= COVERAGE_MIN eligible origins
//   with fresh explicit results this round; then a CANDIDATE iff
//     - >= MIN_FLEET_FAILURES origins in F fail t AND failing fraction >= FAIL_FRAC
//     - each OTHER fleet's success fraction for t >= OK_FRAC
//   i.e. "fleet F can't reach t, everyone else can". Integer math avoids rounding.
//
// FALSE-POSITIVE GATES:
//   - Baseline eligibility (per origin, per target) from the ~24h success
//     history: an (origin,target) only counts if it succeeded in >= BASELINE_FRAC
//     of that origin's recent rounds. Chronically-dead targets (probe_disabled,
//     known-dead hetzner/opt-in regions) have no healthy baseline, so they never
//     qualify and can't raise a candidate — no hardcoded exclusion list.
//   - Stale carried-forward columns (probe.yml marks them stale:true) are skipped
//     and never counted as a fresh observation.
//   - A candidate must be CONFIRMED across two consecutive accepted rounds before
//     it is issue-eligible; a single-round candidate is recorded, never alerted.
//
// ISSUE POLICY (only when --persist state advances a candidate to confirmed):
//   hasProblem=true only for CONFIRMED events, so the workflow opens/refreshes
//   ONE issue for genuinely persistent fleet-wide asymmetries, not for the
//   common self-healing single-round blip.
//
// DATA SOURCE: public status-branch latest.json (current round) + history.json
// (~24h successful samples). No cloud creds, no cloud calls -> zero added cost.
// STATE: a small rolling fleet-monitor.json (active events + last slot), NOT a
// per-cell log. Lives on the dedicated cn-monitor branch alongside cn-monitor.json.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const LATEST_URL = process.env.LATEST_URL || 'https://raw.githubusercontent.com/cloudpickr/cloudping.me/status/latest.json'
const HISTORY_URL = process.env.HISTORY_URL || 'https://raw.githubusercontent.com/cloudpickr/cloudping.me/status/history.json'
const STATE_PATH = process.env.FLEET_MONITOR_STATE || 'fleet-monitor.json'
const FETCH_TIMEOUT_MS = 20000

// Fleets are derived from the origin-id prefix (aws-*, gcp-*, azure-*).
const FLEETS = ['aws', 'gcp', 'azure']
// Minimum eligible origins per fleet for a comparison to be valid (a fleet with
// too few reporting origins this round can't support a fleet-wide claim).
const COVERAGE_MIN = 3
// A candidate needs at least this many failing origins in the suspect fleet AND
// this failing fraction, while each other fleet succeeds at >= OK_FRAC.
const MIN_FLEET_FAILURES = 3
const FAIL_FRAC = 0.9 // 90% of the suspect fleet's eligible origins fail t
const OK_FRAC = 0.9 // 90% of each other fleet's eligible origins succeed at t
// Baseline: an (origin,target) is eligible only if it succeeded in >= this
// fraction of that origin's recent rounds — so chronically-dead / probe_disabled
// targets (no healthy baseline) never qualify.
const BASELINE_FRAC = 0.8
const BASELINE_MIN_ROUNDS = 20 // an origin needs this many recent rounds to judge

function fleetOf(origin) {
  const p = origin.split('-')[0]
  return FLEETS.includes(p) ? p : null
}

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

// Build per-origin baseline: the set of (origin, provider, region) that succeeded
// in >= BASELINE_FRAC of that origin's recent rounds. history keys are
// `origin\tprovider\tregion` -> [[ts, ms], ...]; successful rounds are [ts, ms]
// and failed attempts are [ts, -1] sentinels (see probe.yml). We take SUCCESSES
// only (ms >= 0) here: derive each origin's recent-round timestamps from the
// union of its cells' success times, then a target is eligible if its success
// timestamps cover >= BASELINE_FRAC of that union (with a minimum round count).
function buildBaseline(history) {
  const byOrigin = new Map() // origin -> { rounds:Set<ts>, cells: Map<targetKey, Set<ts>> }
  for (const [key, samples] of Object.entries(history)) {
    const parts = key.split('\t')
    if (parts.length !== 3) continue
    const [origin, provider, region] = parts
    if (!fleetOf(origin)) continue
    // SUCCESSES only. history now also stores failed attempts as [ts, -1]
    // sentinels (see probe.yml); a failure timestamp must not seed the success
    // baseline, or a chronically-dead target (attempted every round, succeeding
    // never) would clear BASELINE_FRAC on attempts alone and become a false
    // fleet-asymmetry candidate.
    const valid = Array.isArray(samples)
      ? samples.filter((s) => Array.isArray(s) && s.length === 2 && typeof s[0] === 'number' && Number.isFinite(s[1]) && s[1] >= 0)
      : []
    if (valid.length === 0) continue
    if (!byOrigin.has(origin)) byOrigin.set(origin, { rounds: new Set(), cells: new Map() })
    const rec = byOrigin.get(origin)
    const tkey = `${provider}\t${region}`
    let set = rec.cells.get(tkey)
    if (!set) {
      set = new Set()
      rec.cells.set(tkey, set)
    }
    for (const [ts] of valid) {
      set.add(ts)
      rec.rounds.add(ts)
    }
  }
  // eligible: Map<origin, Set<targetKey>>
  const eligible = new Map()
  for (const [origin, rec] of byOrigin) {
    const nRounds = rec.rounds.size
    if (nRounds < BASELINE_MIN_ROUNDS) continue
    const need = nRounds * BASELINE_FRAC
    const set = new Set()
    for (const [tkey, tsSet] of rec.cells) {
      if (tsSet.size >= need) set.add(tkey)
    }
    eligible.set(origin, set)
  }
  return eligible
}

// Evaluate the current round for cross-fleet asymmetry candidates.
// `frozenPairs` is a Set of `${origin}\t${tkey}` that must be treated as eligible
// even if their rolling baseline has aged out — used to keep an ACTIVE event's
// target under evaluation (a continuing outage removes successes from the 24h
// history, which would otherwise drop the target below the baseline and make the
// still-failing event vanish as a false "recovery"; codex review).
function findCandidates(latest, eligible, frozenPairs) {
  const from = latest.from || {}
  // Collect explicit (non-stale) results per target per fleet, restricted to
  // baseline-eligible (origin,target) pairs.
  // targetKey -> fleet -> { fail:[origins], ok:[origins], eligibleOrigins:Set }
  const perTarget = new Map()
  const fleetOrigins = { aws: new Set(), gcp: new Set(), azure: new Set() }

  for (const [origin, col] of Object.entries(from)) {
    if (!col || col.stale) continue
    const fleet = fleetOf(origin)
    if (!fleet) continue
    fleetOrigins[fleet].add(origin)
    const elig = eligible.get(origin)
    for (const r of col.results || []) {
      const tkey = `${r.provider}\t${r.region}`
      const isEligible = (elig && elig.has(tkey)) || (frozenPairs && frozenPairs.has(`${origin}\t${tkey}`))
      if (!isEligible) continue // only judge targets this origin normally reaches (or a frozen active-event target)
      if (typeof r.ok !== 'boolean') continue
      if (!perTarget.has(tkey)) perTarget.set(tkey, { aws: { fail: [], ok: [] }, gcp: { fail: [], ok: [] }, azure: { fail: [], ok: [] } })
      const slot = perTarget.get(tkey)[fleet]
      if (r.ok) slot.ok.push(origin)
      else slot.fail.push(origin)
    }
  }

  const candidates = []
  for (const [tkey, byFleet] of perTarget) {
    for (const F of FLEETS) {
      const others = FLEETS.filter((x) => x !== F)
      const sF = byFleet[F]
      const nF = sF.ok.length + sF.fail.length
      if (nF < COVERAGE_MIN) continue
      // suspect fleet mostly fails t
      if (sF.fail.length < MIN_FLEET_FAILURES) continue
      if (sF.fail.length * 100 < FAIL_FRAC * 100 * nF) continue // fail.length/nF >= FAIL_FRAC
      // both other fleets mostly succeed t
      let othersOk = true
      const otherStats = {}
      for (const G of others) {
        const sG = byFleet[G]
        const nG = sG.ok.length + sG.fail.length
        if (nG < COVERAGE_MIN) {
          othersOk = false
          break
        }
        if (sG.ok.length * 100 < OK_FRAC * 100 * nG) {
          othersOk = false
          break
        }
        otherStats[G] = { ok: sG.ok.length, n: nG }
      }
      if (!othersOk) continue
      const [provider, region] = tkey.split('\t')
      candidates.push({
        key: `${F}|${provider}|${region}`,
        fleet: F,
        provider,
        region,
        failed: sF.fail.length,
        observed: nF,
        others: otherStats,
      })
    }
  }
  return candidates
}

// State schema v2: slots are the rounds' own timestamps. v1 state stored 30-min
// FLOORED bucket boundaries, which are not real round times; comparing a real
// timestamp against one can look "adjacent" for a re-run of the same round
// (e.g. the same round re-processed 20-30 min after its bucket boundary) and
// falsely advance a streak. Migrate by dropping every stored slot: confirmed
// events stay active (recovery then needs fresh consecutive clear rounds),
// unconfirmed streaks restart from 1.
const STATE_VERSION = 2
export function migrateState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { version: STATE_VERSION, lastSlot: null, events: {} }
  // Discard malformed structure rather than throwing later in advanceState.
  const events = {}
  if (s.events && typeof s.events === 'object' && !Array.isArray(s.events)) {
    for (const [k, ev] of Object.entries(s.events)) {
      if (ev && typeof ev === 'object' && !Array.isArray(ev)) events[k] = ev
    }
  }
  s.events = events
  if (typeof s.lastSlot !== 'string') s.lastSlot = null
  if (s.version !== STATE_VERSION) {
    s.lastSlot = null
    for (const ev of Object.values(s.events)) {
      if (!ev) continue
      ev.lastSlot = null
      if (!ev.confirmed) ev.candidateStreak = 0
      ev.recoveryStreak = 0
    }
    s.version = STATE_VERSION
  }
  return s
}

function loadState() {
  if (!existsSync(STATE_PATH)) return migrateState(null)
  try {
    return migrateState(JSON.parse(readFileSync(STATE_PATH, 'utf8')))
  } catch {
    return migrateState(null)
  }
}

// A "slot" is the round's OWN published timestamp (latest.at), so re-runs on the
// same published round (workflow_run + backup crons) map to the same slot and
// can't manufacture a confirmation streak. We deliberately do NOT floor to a fixed
// bucket width: the probe cadence is 50 min (#126), and a 30-min bucket splits
// rounds 50 min apart into non-adjacent slots about half the time, which resets
// the 2-round confirmation/recovery gates and silences the monitor.
const ROUND_INTERVAL_MS = 50 * 60 * 1000 // nominal probe cadence
// Two rounds are CONSECUTIVE when the gap is within [MIN, MAX]. MAX is 1.5x the
// cadence (jitter tolerant, but a fully skipped round ~100 min is NOT adjacent);
// MIN rejects near-duplicate rounds so two rounds a few minutes apart can't
// confirm an event on their own.
const MIN_ADJACENT_GAP_MS = 20 * 60 * 1000
const MAX_ADJACENT_GAP_MS = Math.round(ROUND_INTERVAL_MS * 1.5)
export function slotOf(latest) {
  const at = latest.at
  const ms = Date.parse(at)
  if (Number.isNaN(ms)) {
    // No usable round timestamp: fall back to a cadence-wide bucket so same-bucket
    // re-runs still dedupe.
    const bucket = Math.floor(Date.now() / ROUND_INTERVAL_MS)
    return new Date(bucket * ROUND_INTERVAL_MS).toISOString()
  }
  return new Date(ms).toISOString()
}
// True iff `slot` follows `prevSlot` by one probe round (cadence-aware). Used so
// a streak only advances across consecutive rounds — a skipped/missed round is
// NOT treated as consecutive, which would otherwise defeat the two-consecutive-
// round confirmation and recovery gates (codex review).
export function isAdjacentSlot(prevSlot, slot) {
  if (!prevSlot) return false
  const a = Date.parse(prevSlot)
  const b = Date.parse(slot)
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  const gap = b - a
  return gap >= MIN_ADJACENT_GAP_MS && gap <= MAX_ADJACENT_GAP_MS
}

// Advance event state for one round. Pure w.r.t. I/O (mutates `state`). Only
// advances on a NEW slot, so repeated same-round runs don't inflate streaks.
export function advanceState(state, candidates, slot) {
  const isNewSlot = state.lastSlot !== slot
  const adjacent = isAdjacentSlot(state.lastSlot, slot)
  const candKeys = new Set(candidates.map((c) => c.key))
  const confirmed = []
  const recovered = []
  if (isNewSlot) {
    // bump / open candidates. A streak only advances if THIS round directly
    // follows the event's previous round (cadence-aware); a gap (missed/skipped
    // round) resets it to 1.
    for (const c of candidates) {
      const prev = state.events[c.key]
      const contiguous = prev && isAdjacentSlot(prev.lastSlot, slot)
      const ev = prev || { firstSlot: slot, candidateStreak: 0, recoveryStreak: 0, confirmed: false, last: null }
      ev.candidateStreak = contiguous ? ev.candidateStreak + 1 : 1
      if (!contiguous && !ev.confirmed) ev.firstSlot = slot
      ev.recoveryStreak = 0
      ev.lastSlot = slot
      ev.last = { failed: c.failed, observed: c.observed, others: c.others }
      // CONFIRMED on the 2nd consecutive candidate round.
      if (ev.candidateStreak >= 2 && !ev.confirmed) {
        ev.confirmed = true
        confirmed.push(c.key)
      }
      state.events[c.key] = ev
    }
    // decay events not seen this round. Recovery also requires CONSECUTIVE clear
    // rounds; a non-adjacent round is inconclusive (we don't know the missed
    // round's state): this round is itself an observed clear round (streak
    // restarts at 1), but clear, missed, clear must NOT recover; the event stays
    // active until a second consecutive clear round arrives.
    for (const [key, ev] of Object.entries(state.events)) {
      if (candKeys.has(key)) continue
      ev.candidateStreak = 0
      ev.recoveryStreak = adjacent ? (ev.recoveryStreak || 0) + 1 : 1
      if (ev.confirmed && adjacent && ev.recoveryStreak >= 2) {
        recovered.push(key)
        delete state.events[key]
      } else if (!ev.confirmed && ev.recoveryStreak >= 2) {
        // an unconfirmed blip that cleared — drop it quietly
        delete state.events[key]
      }
    }
    state.lastSlot = slot
  }
  return { isNewSlot, adjacent, confirmed, recovered }
}

async function main() {
  const wantJson = process.argv.includes('--json')
  const persist = process.argv.includes('--persist')

  const [latest, history] = await Promise.all([getJson(LATEST_URL), getJson(HISTORY_URL)])
  const eligible = buildBaseline(history)
  const slot = slotOf(latest)

  const state = loadState()
  // Freeze eligibility for targets of already-active events: rebuild the set of
  // (origin, target) pairs that any active event covers, so a continuing outage
  // (which erodes the target's 24h success baseline) can't drop it from
  // evaluation and fake a recovery. We freeze the whole fleet's origins for that
  // target — the candidate rule still needs the real cross-fleet asymmetry.
  const frozenPairs = new Set()
  for (const [key, ev] of Object.entries(state.events || {})) {
    if (!ev || !ev.confirmed) continue
    const [fleet, provider, region] = key.split('|')
    const tkey = `${provider}\t${region}`
    for (const origin of Object.keys(latest.from || {})) {
      if (fleetOf(origin) === fleet) frozenPairs.add(`${origin}\t${tkey}`)
    }
  }

  const candidates = findCandidates(latest, eligible, frozenPairs)
  const candByKey = new Map(candidates.map((c) => [c.key, c]))
  const { isNewSlot, confirmed, recovered } = advanceState(state, candidates, slot)

  const activeConfirmed = Object.entries(state.events)
    .filter(([, ev]) => ev.confirmed)
    .map(([key, ev]) => ({ key, ...ev.last, since: ev.firstSlot }))

  const result = {
    generatedAt: new Date().toISOString(),
    roundAt: latest.at || null,
    slot,
    newSlot: isNewSlot,
    candidatesThisRound: candidates,
    newlyConfirmed: confirmed.map((k) => candByKey.get(k) || { key: k }),
    recovered,
    activeConfirmed,
    // Only CONFIRMED events warrant an issue — single-round blips self-heal.
    hasProblem: activeConfirmed.length > 0,
  }

  if (persist) writeFileSync(STATE_PATH, JSON.stringify(state))

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return
  }

  console.log('# Fleet reachability monitor\n')
  console.log(`round ${result.roundAt} (slot ${slot}, newSlot=${isNewSlot})`)
  console.log(`eligible origins: ${[...eligible.keys()].length}`)
  if (candidates.length === 0) {
    console.log('\nNo cross-fleet asymmetry candidates this round.')
  } else {
    console.log(`\nCandidates this round (${candidates.length}):`)
    for (const c of candidates) {
      const others = Object.entries(c.others)
        .map(([g, s]) => `${g} ${s.ok}/${s.n}`)
        .join(', ')
      console.log(`  ${c.fleet} fleet fails ${c.provider}:${c.region} (${c.failed}/${c.observed}); others ok: ${others}`)
    }
  }
  if (activeConfirmed.length) {
    console.log(`\n⚠️  CONFIRMED (>=2 consecutive rounds):`)
    for (const e of activeConfirmed) console.log(`    - ${e.key} since ${e.since}`)
  }
  console.log(
    result.hasProblem
      ? '\nA confirmed fleet-wide asymmetry is active — issue will be opened/refreshed.'
      : '\nNothing confirmed. Single-round candidates (if any) are recorded and stay quiet.'
  )
}

// Run only when executed directly (not when imported by the tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
