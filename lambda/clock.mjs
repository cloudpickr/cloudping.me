// Defaults target the canonical deployment. When running this clock Lambda from
// a fork, set GITHUB_REPO (and optionally GITHUB_WORKFLOW / GITHUB_REF) so the
// workflow_dispatch hits your own repository instead of cloudpickr/cloudping.me.
const DEFAULT_REPO = 'cloudpickr/cloudping.me'
const DEFAULT_WORKFLOW = 'probe.yml'
const DEFAULT_REF = 'main'

export async function handler() {
  const token = process.env.GITHUB_DISPATCH_TOKEN
  if (!token) throw new Error('GITHUB_DISPATCH_TOKEN is not set')

  const repo = process.env.GITHUB_REPO || DEFAULT_REPO
  const workflow = process.env.GITHUB_WORKFLOW || DEFAULT_WORKFLOW
  const ref = process.env.GITHUB_REF || DEFAULT_REF
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cloudping.me-clock',
    },
    body: JSON.stringify({ ref }),
  })

  if (res.status !== 204) {
    const text = await res.text()
    throw new Error(`workflow_dispatch ${res.status}: ${text}`)
  }

  return { ok: true, repo, workflow, ref }
}
