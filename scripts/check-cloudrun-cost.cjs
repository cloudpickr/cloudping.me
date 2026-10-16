/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS regression harness. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

async function checkHandler(env, expectedConcurrency, expectedDiagnostics) {
  let handler
  const calls = []
  const snapshot = { probe: { id: 'gcp-test' }, results: [] }
  const code = ts.transpileModule(fs.readFileSync('cloudrun/server.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(code, {
    exports: {},
    process: { env },
    console: { log() {}, error() {} },
    require(id) {
      if (id === 'http')
        return {
          createServer(fn) {
            handler = fn
            return { listen() {} }
          },
        }
      if (id.endsWith('/probe-auth')) return { authorized: (value) => value === 'Bearer test-only' }
      if (id.endsWith('/probe-server'))
        return {
          runProbe: async (...args) => {
            calls.push(args)
            return snapshot
          },
        }
      throw new Error(`Unexpected import: ${id}`)
    },
  })
  async function request(method, headers) {
    return new Promise((resolve) => {
      let status
      handler(
        { method, headers },
        {
          writeHead(value) {
            status = value
          },
          end(body) {
            resolve({ status, body })
          },
        }
      )
    })
  }
  assert.equal((await request('GET', {})).status, 405)
  assert.equal((await request('POST', {})).status, 401)
  assert.equal(calls.length, 0, 'Rejected requests must not spend probe CPU')
  const response = await request('POST', { 'x-probe-secret': 'test-only', authorization: 'Bearer google-identity-token' })
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), snapshot)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], expectedConcurrency)
  assert.equal(calls[0][1].reachabilityDiagnostics, expectedDiagnostics)
}

async function main() {
  await checkHandler({}, 12, false)
  await checkHandler({ PROBE_CONCURRENCY: 'invalid', PROBE_REACHABILITY_DIAGNOSTICS: '0' }, 12, false)
  await checkHandler({ PROBE_CONCURRENCY: '8', PROBE_REACHABILITY_DIAGNOSTICS: '1' }, 8, true)
  for (const file of ['cloudrun/deploy.sh', '.github/workflows/deploy-gcp.yml']) {
    const source = fs.readFileSync(file, 'utf8')
    const deploys = source.match(/gcloud run deploy[\s\S]*?--quiet/g) || []
    assert.ok(deploys.length, `${file}: missing deployment command`)
    for (const deploy of deploys) assert.ok(deploy.includes('--no-cpu-boost'), `${file}: startup boost must remain disabled`)
  }
  assert.match(fs.readFileSync('infra/terraform/gcp.tf', 'utf8'), /startup_cpu_boost\s*=\s*false/)
  console.log('PASS: Cloud Run auth, unchanged concurrency, diagnostic opt-in, and boost-off deployment parity')
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
