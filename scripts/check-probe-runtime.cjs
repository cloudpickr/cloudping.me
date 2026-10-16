// node scripts/check-probe-runtime.cjs [--live | --target=provider/region]
// --live runs HEAD and the working tree sequentially against the real catalog.
// It makes public probe GETs only: no AWS deployment, invocation, or credentials.
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS harness. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const ts = require('typescript')

const baseline = execFileSync('git', ['show', 'HEAD:src/fns/probe-server.ts'], { encoding: 'utf8' })
const changed = fs.readFileSync('src/fns/probe-server.ts', 'utf8')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function load(source, data, fetchImpl = fetch) {
  const logs = []
  const timeouts = []
  const modules = new Map()
  const env = { PROBE_ORIGIN_ID: 'aws-ap-northeast-2' }
  function compile(source, filename) {
    const exports = {}
    const code = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText
    vm.runInNewContext(
      code,
      {
        exports,
        module: { exports },
        require: (id) => {
          if (id === '@app/data' && data) return data
          if (id === '@app/data') return local(path.resolve('src/data/index.ts'))
          if (id.startsWith('.')) return local(path.resolve(path.dirname(filename), id))
          return require(id)
        },
        fetch: fetchImpl,
        URL,
        AbortController,
        performance,
        Date,
        process: { env, cpuUsage: process.cpuUsage.bind(process) },
        setTimeout: (fn, ms) => {
          timeouts.push(ms)
          return setTimeout(fn, ms)
        },
        clearTimeout,
        console: { log: (line) => logs.push(JSON.parse(line)) },
      },
      { filename }
    )
    return exports
  }
  function local(filename) {
    if (filename.endsWith('.json')) return JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (!path.extname(filename)) filename += '.ts'
    if (!modules.has(filename)) modules.set(filename, compile(fs.readFileSync(filename, 'utf8'), filename))
    return modules.get(filename)
  }
  const probe = compile(source + '\nexports.pingTarget = pingTarget;', path.resolve('src/fns/probe-server.ts'))
  return { ...probe, logs, timeouts, env, data: data || local(path.resolve('src/data/index.ts')) }
}

async function checkSamples() {
  for (const scenario of [
    { name: 'healthy', failures: [], ok: true, calls: 5, samples: 4 },
    { name: 'warmup retry', failures: [0], ok: true, calls: 6, samples: 4 },
    { name: 'both warmups fail', failures: [0, 1], ok: false, calls: 2 },
    { name: 'one sample fails', failures: [2], ok: true, calls: 5, samples: 3 },
    { name: 'two samples fail', failures: [1, 2], ok: false, calls: 3 },
  ]) {
    let calls = 0
    const probe = load(changed, null, async () => {
      const index = calls++
      if (scenario.failures.includes(index)) {
        const error = new Error('timeout')
        error.name = 'AbortError'
        throw error
      }
      await sleep(5)
      return new Response('ok')
    })
    const result = await probe.pingTarget('https://example.test/ping', 3000, { stopWarmupOnSuccess: true })
    assert.equal(!('error' in result), scenario.ok, scenario.name)
    assert.equal(calls, scenario.calls, scenario.name)
    if (scenario.ok) {
      assert.equal(result.samples, scenario.samples)
      assert.equal(result.ms, Math.min(...result.raw.map((sample) => sample.ms)))
    } else assert.equal(result.error, 'timeout')
    assert.equal(probe.timeouts[0], 7000)
    assert.ok(probe.timeouts.slice(1).every((ms) => ms === 3000))
  }
  // Isolated self/near passes retain their full warmup and sample sequences.
  let calls = 0
  const probe = load(changed, null, async () => {
    calls++
    await sleep(5)
    return new Response('ok')
  })
  assert.equal((await probe.pingTarget('https://example.test/ping', 3000)).samples, 4)
  assert.equal(calls, 6)
}

async function checkRound(egressDiagnostics = false) {
  const regions = [
    { key: 'disabled', country: 'US', probe_disabled: true },
    { key: 'far', country: 'US' },
    { key: 'ap-northeast-2', country: 'KR' },
    { key: 'near', country: 'KR' },
    { key: 'down', country: 'US' },
  ].map((r) => ({ ...r, location: r.key, geo: 'test', ping_url: `https://${r.key}.test/ping` }))
  const counts = {}
  const probe = load(changed, { getAllProviders: () => [{ key: 'aws' }], getAllCloudRegions: () => ({ aws: regions }) }, async (url) => {
    const host = new URL(url).hostname
    counts[host] = (counts[host] || 0) + 1
    if (host === 'checkip.amazonaws.com') return new Response('192.0.2.1\n')
    if (host === 'down.test') throw new Error('network')
    await sleep(host === 'far.test' ? 70 : 5)
    return new Response('ok')
  })
  if (egressDiagnostics) probe.env.PROBE_EGRESS_DIAGNOSTICS = '1'
  const result = await probe.runProbe(12, { reachabilityDiagnostics: false })
  assert.deepEqual(
    Array.from(result.results, (r) => r.region),
    ['far', 'ap-northeast-2', 'near', 'down']
  )
  assert.equal(counts['disabled.test'], undefined)
  assert.equal(counts['far.test'], 5)
  assert.equal(counts['ap-northeast-2.test'], 6)
  assert.equal(counts['near.test'], 9) // 5 pooled + 1 warmup/3 samples in isolation
  assert.equal(counts['down.test'], 2)
  assert.equal(result.results.filter((r) => !r.ok).length, 1)
  const summary = probe.logs.find((line) => line.kind === 'probe-round-summary')
  assert.equal(summary.skippedDisabled, 1)
  assert.equal(counts['checkip.amazonaws.com'], egressDiagnostics ? 2 : undefined)
  assert.equal(summary.egressDiagnostics, egressDiagnostics)
  assert.equal(summary.egressIp, egressDiagnostics ? '192.0.2.1' : null)
  assert.equal(summary.egressIpEnd, egressDiagnostics ? '192.0.2.1' : null)
  assert.equal(summary.egressIpStable, egressDiagnostics ? true : null)
  assert.equal(summary.blackholeStage, null)
  assert.equal(summary.targetUnreachableStage, null)
  assert.ok(summary.measurementMs <= summary.durationMs)
}

async function liveRound(source, label, concurrency, diagnostics) {
  let requests = 0
  const probe = load(source, null, (...args) => {
    requests++
    return fetch(...args)
  })
  const snapshot = await probe.runProbe(concurrency, { reachabilityDiagnostics: diagnostics })
  const summary = probe.logs.find((line) => line.kind === 'probe-round-summary')
  const disabled = new Set(
    Object.entries(probe.data.getAllCloudRegions()).flatMap(([provider, regions]) => regions.filter((r) => r.probe_disabled).map((r) => `${provider}/${r.key}`))
  )
  const active = snapshot.results.filter((r) => !disabled.has(`${r.provider}/${r.region}`))
  const failed = active.filter((r) => !r.ok).map((r) => `${r.provider}/${r.region}`)
  const result = {
    label,
    concurrency,
    durationMs: snapshot.probe.durationMs,
    poolMs: summary.cpuStarvation.wallMs,
    nearMs: summary.nearCellRemeasure.spentMs,
    requests,
    cells: snapshot.results.length,
    activeCells: active.length,
    failed,
    failRate: failed.length / active.length,
    eventLoopDelay: summary.eventLoopDelay,
    self: summary.nearCellRemeasure.selfMs,
  }
  console.log(JSON.stringify(result))
  return { result, cells: new Map(active.map((r) => [`${r.provider}/${r.region}`, r])) }
}

async function main() {
  const targetArg = process.argv.find((arg) => arg.startsWith('--target='))
  if (targetArg) {
    let requests = 0
    const fetchImpl = (...args) => {
      requests++
      return fetch(...args)
    }
    const probes = { before: load(baseline, null, fetchImpl), after: load(changed, null, fetchImpl) }
    const [provider, region] = targetArg.slice('--target='.length).split('/')
    const target = probes.after.data.getAllCloudRegions()[provider]?.find((r) => r.key === region)
    assert.ok(target?.ping_url, 'unknown target')
    const rounds = { before: [], after: [] }
    for (let i = 0; i < 10; i++) {
      for (const mode of i % 2 ? ['after', 'before'] : ['before', 'after']) {
        const initialRequests = requests
        const result = await probes[mode].pingTarget(target.ping_url, 3000, { stopWarmupOnSuccess: true })
        const sorted = result.raw?.map((s) => s.ms).sort((a, b) => a - b)
        rounds[mode].push({
          ...('error' in result ? result : { min: result.ms, median: sorted[Math.ceil(sorted.length / 2) - 1], samples: result.samples }),
          requests: requests - initialRequests,
        })
      }
    }
    console.log(JSON.stringify({ node: process.version, target: `${provider}/${region}`, rounds }))
  } else if (process.argv.includes('--live')) {
    console.log(JSON.stringify({ node: process.version, baseline: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }))
    const before = await liveRound(baseline, 'before', 12, true)
    const after = await liveRound(changed, 'after', 12, false)
    const candidate = await liveRound(changed, 'candidate-only', 24, false)
    for (const run of [after, candidate]) {
      const ratios = []
      const lost = []
      const gained = []
      for (const [key, r] of before.cells) {
        const next = run.cells.get(key)
        if (r.ok && !next?.ok) lost.push(key)
        if (!r.ok && next?.ok) gained.push(key)
        if (r.ok && next?.ok && r.ms >= 1) ratios.push(next.ms / r.ms)
      }
      ratios.sort((a, b) => a - b)
      console.log(JSON.stringify({ comparison: run.result.label, lost, gained, medianLatencyRatio: ratios[Math.floor(ratios.length / 2)] }))
    }
  } else {
    await checkSamples()
    await checkRound()
    await checkRound(true)
    console.log('PASS: warmup retry, 4/3 sample gate, timeout budgets, isolated passes, disabled skip, result order, and diagnostics opt-out')
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
