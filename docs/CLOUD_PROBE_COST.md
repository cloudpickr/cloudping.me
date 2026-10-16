# AWS / GCP probe cost reduction — 2026-10-16

## Scope

Keep the 30-minute measurement cadence, enabled target catalog, four pooled
samples with three-success gating, timeout budgets, isolated self/near passes,
and AWS 512 MB / GCP 0.5 vCPU + 512 MiB allocations unchanged.

Changes in this worktree:

- Cloud Run opts out of post-measurement DNS/TCP/TLS investigations, matching
  Lambda. `PROBE_REACHABILITY_DIAGNOSTICS=1` restores those investigations.
- When reachability diagnostics are disabled, shared probe code also skips the
  start/end egress-IP checks. These HTTP calls are investigation telemetry, not
  latency samples. Skipping the final call removes up to 2 seconds of tail wait;
  this is a ceiling, not an expected saving on every round. Summary IP fields
  are `null`, with `egressDiagnostics:false`, not a fabricated stable address.
  `PROBE_EGRESS_DIAGNOSTICS=1` independently restores both checks. Callers such
  as Azure that retain reachability diagnostics keep their existing behavior.
- GitHub deployment, manual deployment (including source builds), and Terraform
  explicitly disable Cloud Run startup CPU boost. CPU allocation otherwise
  remains request-based, with zero minimum instances.

Cloud Run boosts a service configured with 0–1 CPU to 2 CPUs during startup and
the following 10 seconds, and bills the boosted allocation. Disabling it can
increase startup latency; validate cold requests, failed cells, and near-cell
readings before fleet rollout. See the
[official CPU configuration documentation](https://docs.cloud.google.com/run/docs/configuring/services/cpu).

## Cost baseline and limits of the estimate

The October 1 00:00–October 16 13:00 UTC Monitoring baseline (before this change)
covered six active GCP probe services plus another Cloud Run service. CPU
allocation totaled 270,675 vCPU-seconds, memory 190,674 GiB-seconds, and requests
21,115. Regional pricing and the shared Tier-1-denominated free credits produce
an estimated full-month compute charge of $10.41, excluding network, tax and
credits. This is not a billing-export or invoice result.

For the six probes, CPU allocation exceeded 0.5 × billable instance seconds by
about 72,645 vCPU-seconds in that interval. This is consistent with repeated
startup boost, but is not proof that every excess second disappears when boost
is disabled. New-revision allocation metrics must confirm the actual saving.
Neither boost removal nor diagnostic opt-out guarantees zero GCP charges.

The original nine-region AWS estimate requires a mean round below about 32
seconds for a hypothetical full month under 400,000 GB-seconds, assuming other
functions maintain their supplied usage rate. The actual AWS fleet has thirteen
probe regions: refresh account-wide consumption before using that nine-region
model as a budget. Removing the two egress checks alone cannot close this gap.

Do not silently change cadence, discard failed targets, lower memory, or remove
isolated measurements to make the arithmetic look better. Cadence changes alter
data freshness and need a separate explicit decision.

## Validation

```sh
node scripts/check-probe-runtime.cjs
node scripts/check-cloudrun-cost.cjs
npx tsc --noEmit
npx eslint scripts/check-probe-runtime.cjs scripts/check-cloudrun-cost.cjs
bash -n cloudrun/deploy.sh
```

The runtime harness verifies unchanged sample/timeout behavior, catalog order,
isolated passes, zero egress calls by default on metered origins, and two egress
calls with explicit opt-in. The Cloud Run harness checks auth, unchanged
concurrency, diagnostic opt-in, and boost-off parity across deployment paths.

### Live GCP canary

Oregon (`us-west1`), existing production image, boost configuration only:

| Configuration | Probe duration | HTTP elapsed | Failed cells |
| --- | ---: | ---: | ---: |
| Boost on, existing revision | 69.601 s | 81.577 s | 0 / 340 |
| Boost off, first request to new revision | 71.069 s | 71.363 s | 0 / 340 |
| Boost off, subsequent request | 68.834 s | 69.124 s | 0 / 340 |

Self readings were 7 / 8 / 7 ms. The new revision is not a controlled cold-start
comparison: deployment readiness and instance reuse can differ. These three
rounds show no obvious failure regression, not statistical equivalence or an
observed billing saving. The service was restored to boost-on after the test;
the code and deployment changes above have not been rolled out by this test.

### Deployment / acceptance

The shared-code change also triggers the existing Azure deployment workflow on
merge, even though Azure retains its diagnostic behavior. Verify each workflow
separately; a successful probe workflow does not imply every origin succeeded.
Do not run Terraform apply for this change: the deployment pipeline is the
normal Cloud Run rollout path, with Terraform updated only to prevent drift.

After rollout, compare new-revision CPU allocation, memory allocation and
billable-instance-time per completed request with the baseline, separating
startup from warm requests. Compare enabled-cell failures by target (especially
intermittent China route failures), isolated self readings and near-cell
distribution. Keep the diagnostic flags available for incident investigations.

Local validation passed on Node 24: runtime and Cloud Run regression harnesses,
TypeScript, repository lint plus explicit CJS lint, production build, both probe
bundles, shell syntax, Terraform format check and git diff whitespace check.

### Live AWS concurrency experiment (not adopted)

Seoul, existing deployed code, 512 MB, alternating 12 / 16 / 12 / 16. Only the
concurrency environment variable changed; all other variables were preserved.

| Pair | Concurrency 12 | Concurrency 16 | Reduction | Failed cells in both rounds |
| --- | ---: | ---: | ---: | --- |
| 1 | 77.327 s | 59.118 s | 23.5% | Same 20 mainland-China targets |
| 2 | 61.025 s | 49.347 s | 19.1% | None |

Self was 2 ms in all four rounds. Among successful baseline cells below 60 ms,
the candidate/baseline per-cell minimum ratio had median 1.00 in both pairs;
the p90 ratio was 1.111 and 1.107. These are cross-round ratios of per-cell
minima, not per-sample medians or proof of equivalent measurement quality.
Event-loop p99 increased from 33.95 to 41.75 ms and from 41.78 to 56.30 ms.
Existing near-cell serial correction remained enabled. The experiment is small
and limited to one origin; concurrency 16 is promising but not selected as a
fleet default. Configuration was restored to 12 with memory unchanged at 512 MB.

The within-pair China failure state matched, but it changed between pairs.
Do not combine the first baseline with the last candidate to advertise a 36%
speedup: route reachability is a major confounder. No claim that the AWS free
tier is restored follows from this experiment.
