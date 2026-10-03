// Daily probe-health census: reads the public 7-day history and flags target
// cells that are collecting far fewer samples than their peers — i.e. the probe
// reaches most targets fine but a subset is intermittently missing.
//
// WHY: a full census (this session) found that a data/config mistake — pointing
// Linode object-storage probes at the bucket-list root '/' — silently dropped
// samples for 22 cells while everything else looked fine. That kind of regression
// doesn't fail CI and isn't visible without aggregating the history. This runs
// daily and, when a cohort of cells is unhealthy, opens (or refreshes) ONE
// tracking issue for a human to diagnose. It never edits data or config.
//
// DATA SOURCE: the public status branch history.json (no AWS creds needed).
// It stores only SUCCESSFUL samples per cell keyed origin\tprovider\tregion; a
// healthy cell accrues ~48 samples over the 7-day window (one per 30-min round).
//
// METHOD: per origin, the typical (modal) sample count is the "expected" number
// for that origin's window. A cell is "starved" if it has < STARVED_FRACTION of
// that typical count. We then group starved cells by provider and by whole
// endpoint host, because a real regression shows up as a COHORT (many cells of
// one provider/host), not one-off noise. Single scattered starved cells (normal
// transient loss) are reported as a count but don't, by themselves, open an issue.
//
// OUTPUT: --json prints a machine summary the workflow uses to decide whether to
// open an issue (hasProblem = any provider/host cohort above the alert threshold).
// Exit 0 always unless the history fetch/parse fails (then non-zero so the
// workflow surfaces real breakage).

const HISTORY_URL = process.env.HISTORY_URL || 'https://raw.githubusercontent.com/cloudpickr/cloudping.me/status/history.json'
const FETCH_TIMEOUT_MS = 20000

// A cell with < this fraction of its origin's typical sample count is "starved".
const STARVED_FRACTION = 0.5
// Only origins whose typical window has at least this many samples are trusted
// (a brand-new origin hasn't accrued enough history to judge peers against).
const MIN_TYPICAL = 10
// A provider/host is flagged only if this many of its cells are starved AND they
// are a meaningful share of that group — so one-off transient loss stays quiet.
const COHORT_MIN_CELLS = 8
const COHORT_MIN_FRACTION = 0.3

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

function mode(nums) {
  const counts = new Map()
  let best = nums[0]
  let bestC = 0
  for (const n of nums) {
    const c = (counts.get(n) || 0) + 1
    counts.set(n, c)
    if (c > bestC) {
      bestC = c
      best = n
    }
  }
  return best
}

function analyze(history) {
  // Group sample counts by origin to derive each origin's "typical" window size.
  const byOrigin = new Map()
  const cells = []
  // A cell whose newest sample is older than this is treated as RETIRED (a key we
  // no longer probe — e.g. an old region id left in history after a rename). Such
  // cells never get new samples, so counting them as "starved" is a false alarm;
  // they age out of the 7-day window on their own. Live cells get a sample every
  // ~30 min, so a few hours of silence means the cell is genuinely gone.
  const RETIRED_AFTER_SEC = 6 * 3600
  const nowSec = Math.floor(Date.now() / 1000)
  for (const [key, samples] of Object.entries(history)) {
    const parts = key.split('\t')
    if (parts.length !== 3) continue
    const [origin, provider, region] = parts
    const valid = Array.isArray(samples) ? samples.filter((s) => Array.isArray(s) && s.length === 2) : []
    const n = valid.length
    const newest = valid.reduce((m, s) => Math.max(m, s[0]), 0)
    // Skip retired cells entirely — they're neither healthy nor a real problem.
    if (n === 0 || nowSec - newest > RETIRED_AFTER_SEC) continue
    cells.push({ origin, provider, region, n })
    if (!byOrigin.has(origin)) byOrigin.set(origin, [])
    byOrigin.get(origin).push(n)
  }

  const typicalByOrigin = new Map()
  for (const [origin, ns] of byOrigin) typicalByOrigin.set(origin, mode(ns))

  // Mark starved cells (well below their origin's typical), skipping origins with
  // too little history to judge.
  const starved = []
  for (const c of cells) {
    const typical = typicalByOrigin.get(c.origin) || 0
    if (typical < MIN_TYPICAL) continue
    if (c.n < typical * STARVED_FRACTION) starved.push({ ...c, typical })
  }

  // Total cells per provider (denominator for cohort fraction).
  const totalByProvider = new Map()
  for (const c of cells) totalByProvider.set(c.provider, (totalByProvider.get(c.provider) || 0) + 1)

  // Cohort by provider.
  const starvedByProvider = new Map()
  for (const c of starved) {
    if (!starvedByProvider.has(c.provider)) starvedByProvider.set(c.provider, [])
    starvedByProvider.get(c.provider).push(c)
  }

  const cohorts = []
  for (const [provider, list] of starvedByProvider) {
    const total = totalByProvider.get(provider) || list.length
    const fraction = list.length / total
    const flagged = list.length >= COHORT_MIN_CELLS && fraction >= COHORT_MIN_FRACTION
    // Representative worst examples (lowest sample counts) for the issue body.
    const examples = [...list]
      .sort((a, b) => a.n - b.n)
      .slice(0, 5)
      .map((c) => `${c.origin} → ${c.provider}:${c.region} (${c.n}/${c.typical})`)
    cohorts.push({ provider, starvedCells: list.length, totalCells: total, fraction: Number(fraction.toFixed(2)), flagged, examples })
  }
  cohorts.sort((a, b) => b.fraction - a.fraction)

  return {
    totalCells: cells.length,
    totalStarved: starved.length,
    cohorts,
    hasProblem: cohorts.some((c) => c.flagged),
  }
}

async function main() {
  const wantJson = process.argv.includes('--json')
  const history = await getJson(HISTORY_URL)
  const result = analyze(history)
  result.generatedAt = new Date().toISOString()

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return
  }

  console.log('# Probe health census\n')
  console.log(`cells: ${result.totalCells} | starved: ${result.totalStarved}\n`)
  for (const c of result.cohorts) {
    const flag = c.flagged ? '⚠️  COHORT' : '·'
    console.log(`${flag} ${c.provider}: ${c.starvedCells}/${c.totalCells} cells starved (${(c.fraction * 100).toFixed(0)}%)`)
    if (c.flagged) for (const e of c.examples) console.log(`    - ${e}`)
  }
  console.log(
    result.hasProblem
      ? '\nAt least one provider cohort is unhealthy — a human should diagnose (endpoint/config/rate-limit).'
      : '\nNo unhealthy cohort. Scattered starved cells (if any) are normal transient loss.'
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
