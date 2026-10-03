# Deployment Architecture

How cloudping.me's measurement origins are built, deployed, and run — across
AWS, GCP, and Azure. The topology is designed around free-tier resources, with
usage monitored because long probe rounds can exceed account-wide compute grants.

## Overview

`/health` shows a latency matrix. **Rows** are target cloud regions; **columns
("From")** are probe *origins* — small serverless services in 30 regions across
three clouds that each measure HTTP round-trip latency to every target.

Two independent concerns, deliberately separated:

1. **Deploy** — get the probe code onto each origin (on `git push`).
2. **Run** — invoke all origins every ~30 min, merge results, publish to `/health`.

## The probe code (one source, three packagings)

All origins run the same logic: `src/fns/probe-server.ts` (`runProbe`), bundled
with esbuild targeting **Node 24**. Each platform wraps it differently:

| Cloud | Artifact | Entry | Auth |
|-------|----------|-------|------|
| AWS Lambda | zip (inline, no registry) | `lambda/handler.ts` | `PROBE_SECRET` Bearer |
| GCP Cloud Run | container image | `cloudrun/server.ts` | Cloud Run IAM ID-token + `X-Probe-Secret` |
| Azure App Service (F1) | zip | `azure/server.ts` | `PROBE_SECRET` Bearer |

`resolveOrigin()` self-labels each column `aws-<region>` / `gcp-<region>` /
`azure-<region>` from `PROBE_ORIGIN_ID` (set at deploy time).

## Deploy: `git push` → per-cloud GitHub Actions (keyless OIDC)

All three clouds deploy from **GitHub Actions** using **keyless federated auth**
(no long-lived secrets). Public repo → Actions minutes are free. Each workflow is
path-filtered so unrelated commits don't trigger it.

```
git push (main)
├── .github/workflows/deploy-aws.yml    ┌ paths: lambda/**, src/fns/**, src/data/**
│     OIDC → AWS role (cloudping-deployer)
│     esbuild → 13 regions: aws lambda update-function-code
├── .github/workflows/deploy-gcp.yml    ┌ paths: cloudrun/**, src/fns/**, src/data/**
│     OIDC → GCP WIF (cloudping-deployer SA)
│     esbuild → docker build → push Artifact Registry → deploy 6 Cloud Run regions
└── .github/workflows/deploy-azure.yml  ┌ paths: azure/**, src/fns/**, src/data/**
      OIDC → Azure AD app (federated)
      esbuild → zip → deploy 11 F1 App Service apps
```

### Why GitHub Actions for all three (not each cloud's native CI)

- **AWS**: CodePipeline V2 bills per run (~$1–2/mo). Actions is $0 on a public repo.
- **GCP**: this project has **no billing → Cloud Build is region-quota-blocked**
  (US regions refuse builds). Building in the Actions runner and pushing the image
  to Artifact Registry sidesteps Cloud Build entirely — any region works.
- **Azure**: App Service Deployment Center's Oryx builder can't handle the
  monorepo esbuild bundle. Actions + zip deploy is clean.

Result: one place (`.github/workflows/`), one auth model (OIDC), $0.

### Regions (30 origins, 7 continents)

- **AWS (13)** — af-south-1, ap-northeast-1, ap-northeast-2, ap-south-1,
  ap-southeast-1, ap-southeast-2, eu-central-1, eu-west-1, me-central-1,
  sa-east-1, us-east-1, us-east-2, us-west-2
- **GCP (6)** — asia-northeast1, asia-northeast3, asia-south1, europe-west1,
  southamerica-east1, us-west1
- **Azure (11)** — australiacentral, brazilsouth, canadacentral, eastus2,
  israelcentral, japaneast, koreacentral, southafricanorth, southeastasia,
  westeurope, westindia

Azure F1 concurrency is tuned only where production failure blocks justify it.
`eastus2`, `israelcentral`, `koreacentral`, `southeastasia`, and `westindia`
run at 4; the other Azure origins run at 8. West India has the least caller
headroom (observed 204–232s versus the 270s limit), so a stale/missing column or
three consecutive rounds above 15% failures is the rollback signal.

Same-city overlaps (e.g. Seoul on AWS+GCP+Azure) are kept intentionally as
cross-cloud backbone comparisons.

## Run: `probe.yml` (the 30-minute clock, unchanged by deploys)

`.github/workflows/probe.yml` is the runtime path, independent of the deploy
workflows:

```
EventBridge (ap-northeast-2, 30-min) ──dispatch──┐   ┌ cron fallback (7,37 * * * *)
                                                 ▼   ▼
                        probe.yml (pull model, one runner)
          ├── AWS: `aws lambda invoke` (OIDC role) for invoke-only regions
          │        + Function URL for Seoul (PROBE_URL_AWS_ICN)
          ├── GCP: per-service ID token (WIF → generateIdToken) + X-Probe-Secret
          └── Azure: PROBE_SECRET Bearer to each public F1 app
                                                 │
                        merge all columns → one latest.json
                                                 │
              ├── push to `status` branch (git backup)
              └── mirror to Vercel Blob (primary read path, ~28-min cadence gate)
                                                 │
                                      /health reads Blob
```

**Pull model, single write.** One runner fans out to all origins in parallel,
merges, and writes **one** `latest.json` per round. This keeps Vercel Blob writes
at ~1,440/month (free tier is 2,000) regardless of origin count — the reason we
did *not* go push-model or Cloudflare R2. Measured round time ≈ 80s (well under
the 30-min window), so no matrix/sharding needed.

Missing origins are carried forward as `stale` for up to 1 hour, then aged out.

## Auth & least privilege

| Cloud | Deploy identity | Scope |
|-------|-----------------|-------|
| AWS | `cloudping-deployer` role (OIDC, `main` only) | `lambda:UpdateFunctionCode` on the 13 function ARNs |
| GCP | `cloudping-deployer` SA (WIF, repo-scoped) | run.admin + artifactregistry.writer + serviceAccountUser |
| Azure | AD app (federated, `main` only) | Website Contributor on the `cloudping-probe` resource group |

Runtime invoke uses separate, invoke-only identities (AWS `cloudping-probe-invoker`,
GCP `cloudping-invoker`) so deploy and run privileges don't overlap.

## Cost

The deployment is designed around free-tier resources, but usage must be monitored:
- AWS Lambda 13 regions can approach or exceed the account-wide 400,000 GB-s/month
  free grant when probe rounds run long; request count remains far below 1 million.
- GCP Cloud Run 6 regions currently run close to the 180,000 vCPU-s/month request-based
  free grant; Artifact Registry image storage remains below 0.5 GB and builds run in Actions.
- Azure F1: free SKU with a 60 CPU-minute/day per-app quota and no production SLA.
- GitHub Actions: free (public repo).
- Vercel Blob: ~1,440 writes/month (free tier 2,000).

## Manual deploy (fallback)

The `*/deploy.sh` scripts still work for manual/one-off deploys:

```bash
export PROBE_SECRET=...
./lambda/deploy.sh us-east-1 eu-central-1 ...        # AWS
PROBE_SECRET=... ./cloudrun/deploy.sh asia-northeast3 ...  # GCP (builds via gcloud)
PROBE_SECRET=... ./azure/deploy.sh australiacentral ...   # Azure
```

## Notes / open items

- **GCP US build**: builds run in the Actions runner now, so US Cloud Run regions
  are deployable without the earlier no-billing Cloud Build quota block. (A support
  ticket to raise the Cloud Build regional quota is optional and no longer required.)
- **Node runtime**: Node 20 reached EOL; everything is pinned to Node 24
  (`nodejs24.x`, `node:24-slim`, esbuild `--target=node24`).
