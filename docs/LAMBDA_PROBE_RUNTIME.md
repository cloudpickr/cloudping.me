# Lambda probe runtime investigation — 2026-10-16

Follow-up metered-origin diagnostic and GCP billing changes are documented in
[CLOUD_PROBE_COST.md](CLOUD_PROBE_COST.md). The measurements below describe the
initial optimization, not the later follow-up.

## Production diagnosis

Read-only CloudWatch analysis of 75 recent rounds in each of two regions
(starting 2026-10-15 UTC), with 512 MB and concurrency 12:

| Mean per round | Seoul | US East (N. Virginia) |
| --- | ---: | ---: |
| Total duration | 76.24 s | 76.32 s |
| Concurrent pool | 61.57 s | 46.33 s |
| Serial near-cell remeasurement | 8.06 s | 26.53 s |
| Remaining time (self, settle, diagnostics, egress, setup) | 6.61 s | 3.46 s |
| Pool CPU seconds / wall seconds | 0.085 | 0.134 |

The catalog contains 344 targets across 18 providers, not just AWS/Azure/GCP.
The pool holds a slot for a whole cell: two sequential warmups, then four
sequential timed requests. Its concurrency is 12 in Lambda; `runProbe`'s default
24 applies to other callers. A dead cell holds a slot for 7 + 3 = 10 seconds.
A successful cell can consume up to 22 seconds including both warmups and four
3-second attempts; at least three plausible samples (>= 1 ms) are required.
The body is drained after the latency clock stops, but still inside the abort
budget and before the worker releases its slot.

After the pool, a 100 ms settle gap precedes the isolated self-cell (2 warmups,
4 samples). Other successful cells below 60 ms, or in the origin's country,
are remeasured serially (1 warmup, 3 samples), keeping the smaller result. The
country rule includes transcontinental US cells, explaining the large US
serial cost. These passes protect the previously observed Lambda CPU-quota
jitter; a low *average* CPU utilization does not rule out short quota stalls.

Post-measurement reachability diagnostics add synchronous network waits:
China DNS + up to three static TCP attempts + resolved TCP + TLS can total
18 seconds, and one unrelated DNS/TCP/TLS investigation can add up to 9 more.
Those are conditional, not additive on every round. A Seoul blackhole round
observed at 96.67 seconds spent 72.70 seconds in the pool and 8.09 seconds in
near remeasurement; its remaining ~15.89 seconds were mostly diagnostics.
The final egress-IP check adds up to 2 seconds; the initial check overlaps work.

`measure-core.ts` contains pure statistics/cache-busting helpers and adds no
network waits. `time.ts` is browser-only: one warmup plus one sample under a
shared 8-second budget. Its page-idle delay does not run inside Lambda. The
24-hour median is calculated from successful per-round minimum values by the
snapshot workflow, not from a new set of requests inside `runProbe`.

## Implemented change and tradeoffs

- Pool warmup stops after its first completed, drained response; a failure
  retains the second attempt. Healthy pool cells make five instead of six
  requests. Four measured attempts, three-success gating, cache busting,
  plausibility filtering, min selection and the history median are retained.
- All four `probe_disabled` targets are omitted: AWS `me-south-1` and Hetzner
  `ash`, `hil`, `sin`. They remain browser targets. They no longer auto-recover
  through per-round server rechecks; remove the flag after a separate recovery
  check. Omitted checks are not recorded as fresh failures. Compare fail rates
  using the same 340 enabled cells, not the old 344-cell denominator.
- Lambda disables optional DNS/TCP/TLS follow-up investigations by default.
  `PROBE_REACHABILITY_DIAGNOSTICS=1` opts back in. Other callers retain their
  previous diagnostic default. Failure results, China/Hong Kong counters,
  egress-IP stability, CPU and event-loop telemetry still run.
- Logs include `measurementMs`, `diagnosticsMs` and `skippedDisabled` to separate
  useful measurement from investigation overhead. The diagnostics duration also
  includes the final egress check and summary bookkeeping.
- `lambda/deploy.sh` now declares 512 MB, matching production and Terraform;
  the old 256 MB constant would have silently reduced memory on a manual deploy.
  No deployed memory configuration was changed.

Timeouts stay at 7000/3000 ms: the code documents an observed ~5500 ms first
connection to Valparaíso and ~2200 ms reconnect. Lowering the ceilings globally
would sacrifice known reachable paths. Self and near-cell passes, their
warmups, and the 100 ms settle gap remain unchanged.

Concurrency 24 is benchmarked as a candidate, not adopted. At 512 MB,
12 / ~0.28 vCPU is ~42 in-flight/vCPU; 24 doubles that density. Local CPU and
event-loop results cannot establish that the Lambda's short quota stalls are
safe at that density. Any increase needs an approved single-region canary with
duration, enabled-cell failures, self/near latency distribution and CPU/loop
telemetry compared across multiple rounds.

## Local whole-catalog measurement

One sequential round per configuration on macOS, Node v24.22.0, with the
Seoul origin ID (no build running concurrently):

| Configuration | Total | Pool | Near serial | HTTP requests | Enabled-cell failures | Self |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| HEAD baseline, concurrency 12 | 83.491 s | 66.332 s | 13.605 s | 2,190 | 2/340 (0.59%) | 8 ms |
| Working tree, concurrency 12 | 71.343 s | 58.624 s | 12.166 s | 1,830 | 3/340 (0.88%) | 8 ms |
| Working tree, concurrency 24, candidate only | 42.762 s | 30.729 s | 11.415 s | 1,837 | 2/340 (0.59%) | 6 ms |

The default change reduced this local round by 14.55% and requests by 16.44%.
Across cells successful in both rounds, the median ratio of new/old reported
minimum latency was 1.00 for both working-tree configurations. This is a
comparison of **per-cell minima**, not proof about per-sample medians or the
24-hour production median. Oracle São Paulo and Frankfurt failed in all three;
OVH Mumbai additionally failed in the default-change round and recovered in
the immediately following candidate round. That variation must not be hidden
by changing the failure-rate denominator or described as proven equivalence.

A focused Node 24 follow-up alternated old/new measurement code in reversed
order every other pair against OVH Mumbai: 10 rounds per version, all 20
successful, with four valid samples in every round. Old code used six requests
per round, new code five. Per-round sample p50 ranged 521–524 ms before and
430–524 ms after. The isolated failure was not reproduced; these observations
still do not prove fleet-wide failure-rate equivalence.

An earlier exploratory Node 22 run gave 85.627 / 78.936 / 48.533 seconds, with
3 / 3 / 2 enabled-cell failures and median minimum ratios of 1.00. Its working
tree round overlapped a build briefly, so the Node 24 run above is the primary
timing comparison. Neither run reproduces Lambda's CPU quota. No post-change
production measurement has been made.

## Reproduce and validate

Use Node 24 and installed repository dependencies:

```sh
node scripts/check-probe-runtime.cjs
node scripts/check-probe-runtime.cjs --live
node scripts/check-probe-runtime.cjs --target=ovh/ap-south-mum
npx tsc --noEmit
npm run lint
npx eslint scripts/check-probe-runtime.cjs
npm run build
bash -n lambda/deploy.sh
```

The first check covers failed-warmup retry, unchanged cold/regular budgets,
four-attempt/three-success gating, preserved isolated passes, disabled skipping,
catalog ordering, and diagnostic opt-out. Live mode sequentially loads the
real probe source from HEAD and the working tree against the real catalog at
concurrency 12, then the working tree at 24. It uses public GETs, requires no
credentials, and performs no Lambda invocation or deployment. Run it without a
concurrent build. It reports enabled-cell fail rates and per-cell minimum
ratios; a few sequential local rounds do not establish statistical equivalence
or reproduce Lambda's CPU quota.

Validation passed: the regression harness on Node 24, TypeScript checking,
repository lint plus explicit CJS harness lint, Next production build on
Node 24, Lambda esbuild bundle targeting Node 24, shell syntax, and diff checks.

## Free-tier arithmetic

Use the supplied October 1–15 estimates, not a new billing export:

```text
MTD account usage                         341,129 GB-s
MTD probe usage                           255,000 GB-s (approximately)
MTD other functions                        86,129 GB-s
Observed invocations/region/day            747 / 15 = 49.8
Memory                                     512 / 1024 = 0.5 GB
31-day invocations across 9 regions         49.8 × 31 × 9 = 13,894.2
Other functions, projected full month       86,129 × 31/15 = 177,999.93 GB-s
Full-month total at mean duration D         177,999.93 + 6,947.1 × D GB-s
Maximum mean D for 400,000 GB-s              31.9558 seconds
```

| Mean Lambda round | Full month with improvement throughout | October if applied after day 15 |
| --- | ---: | ---: |
| 32 s | 400,307 GB-s | 547,739 GB-s |
| 40 s | 455,884 GB-s | 576,424 GB-s |
| 50 s | 525,355 GB-s | 612,280 GB-s |
| 60 s | 594,826 GB-s | 648,136 GB-s |
| 76 s | 705,980 GB-s | 705,506 GB-s |

The partial-month formula is `341,129 + 86,129 × 16/15 + 3,585.6 × D`.
Even setting future probe duration to zero leaves ~433,000 GB-s in October if
other functions keep their existing pace. Returning this month to 400,000 GB-s
is therefore impossible through this probe-only change. Future full months
need a measured fleet average below ~31.96 seconds; local results cannot
certify that target. Actual billed duration also includes small wrapper/init
overheads, so a rollout should target additional headroom.

The [AWS Lambda pricing page](https://aws.amazon.com/lambda/pricing/) confirms
the account-wide monthly 400,000 GB-second allowance. The supplied usage and
invocation estimates are approximate, and projections assume their pace stays
constant. No memory reduction or scheduling-frequency change is included.

No commit, PR, or deployment was made during this investigation.
