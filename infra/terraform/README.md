# Terraform — cloudping.me infrastructure

Imports the already-deployed cloudping.me infrastructure (AWS + GCP + Azure) and
the deploy-pipeline identities into Terraform state managed by **HCP Terraform**
(org `froguin`, project/workspace `cloudping`). This is an **import + management**
layer, not the deploy path — actual code deploys still run through
`.github/workflows/deploy-*.yml` and `*/deploy.sh`.

## Repo path & transferring to a new owner

The GitHub repo path (`cloudpickr/cloudping.me`) that the OIDC trust and the clock
Lambda depend on is centralized into three plaintext (non-secret) variables in
`variables.tf`:

- `github_repo` — slug `owner/name`. Used by the GCP WIF `assertion.repository`
  condition + IAM `attribute.repository` member, and the clock Lambda's
  `GITHUB_REPO` dispatch target.
- `aws_oidc_subject` / `azure_oidc_subject` — the **full** GitHub Actions OIDC
  `sub` claim trusted by the AWS IAM roles and the Azure AD federated credential.

Why two kinds: as of GitHub's 2026-07-15 change, **renaming or transferring a
repo switches the OIDC `sub` claim to the immutable format**
`repo:<owner>@<OWNER_ID>/<name>@<REPO_ID>:ref:refs/heads/main`. The `sub` can no
longer be rebuilt from the slug, so AWS/Azure take the whole subject string. The
GCP `assertion.repository` / `attribute.repository` claims are **not** affected
and keep using the plain slug (`github_repo`).

> These are overridable in the HCP workspace, but this workspace runs
> `execution-mode = local`, so HCP variable values do **not** apply to local
> `plan`/`apply` — the `variables.tf` defaults (or `*.auto.tfvars` /
> `TF_VAR_*`) are what local runs use. Keep the defaults current.

### Transfer cutover procedure

1. **Parameterize first (done):** repo path is centralized in the three
   variables above; `terraform plan` reports **No changes** against the current
   `cloudpickr/cloudping.me` deployment.
2. **Get the new subject** for the destination owner: use GitHub's OIDC settings
   "preview subject claim" endpoint before transfer, or read the token `sub`
   after transfer. Grab the new `OWNER_ID` / `REPO_ID`.
3. **Transfer** the repo to the new owner on GitHub.
4. **Apply the new identity** locally (local cloud creds, independent of GitHub
   OIDC): set `github_repo`, `aws_oidc_subject`, `azure_oidc_subject` to the new
   values and `terraform apply`. Verify each deploy workflow authenticates.
5. **Minimize downtime (optional):** to avoid an auth gap, add dual trust before
   transfer — both old+new AWS subjects, both GCP repository conditions/IAM
   members, and a second Azure federated credential — then remove the old trust
   after step 4 verifies.

Also confirm the clock Lambda's `GITHUB_DISPATCH_TOKEN` can reach the
transferred repo, and update the non-Terraform references (e.g. the GitHub link
in `src/pages/index.tsx`, monitor-workflow `LATEST_URL`/`HISTORY_URL`). The
`cloudping.me` domain, branding, and the HCP org name do **not** change for a
repo-path transfer.

## What's managed (82 resources)

- **AWS (32)**: 13 `cloudping-probe` Lambdas (nodejs24.x), the `cloudping-probe-clock`
  Lambda (kept on nodejs20.x — a separate change owns any runtime bump), the
  EventBridge `rate(30 minutes)` rule + target + permission, 4 Function URLs,
  3 IAM roles + policies, and the GitHub Actions OIDC provider.
- **GCP (23)**: 6 Cloud Run probe services, Artifact Registry repo, the Workload
  Identity Federation pool/provider, and the deployer/invoker service accounts + IAM.
- **Azure (27)**: the `cloudping-probe` resource group, 11 F1 App Service plans + web
  apps (NODE|24-lts), and the Azure AD app + federated credential + role assignment.

## Execution model (local exec, HCP state)

The workspace runs with **`execution-mode = local`**: Terraform executes on your
machine using your local `aws` / `gcloud` / `az` CLI credentials, while **state
lives in HCP** (encrypted, locked, versioned). You never manage a state file
by hand.

## Secrets

Two secrets are consumed by the config: `probe_secret` and `github_dispatch_token`
(both `sensitive`). They are stored in **two** places, and must be rotated in both:

1. **`secrets.auto.tfvars`** (this directory, git-ignored) — the source of values
   for local runs. Terraform auto-loads `*.auto.tfvars`, so `plan`/`apply` need no
   `TF_VAR_*` exports and never read them back out of a deployed resource. Copy
   `secrets.auto.tfvars.example` and fill it in.
2. **HCP workspace variables** (sensitive) — kept for the future remote-execution
   path. HCP sensitive variables are write-only (values can't be read back), which
   is why local runs keep their own copy in `secrets.auto.tfvars`.

> The `.tf` sources contain **no** plaintext secrets — only `var.` references.

## Usage

```bash
cd infra/terraform
cp secrets.auto.tfvars.example secrets.auto.tfvars   # first time only; fill in values
terraform init
terraform plan     # should report: No changes
terraform apply
```

Make sure your CLIs are authenticated: `aws sts get-caller-identity`,
`gcloud config list`, `az account show`.

## Adding a new region

New regions are still **deployed** by the existing scripts/workflows, then
**imported** here:

1. Deploy the new origin the usual way (e.g. `PROBE_SECRET=… ./lambda/deploy.sh <region>`
   for AWS, or the GCP/Azure `deploy.sh`). That path already injects `PROBE_SECRET`.
2. Add the region to the relevant list in `variables.tf` (`aws_probe_regions` /
   `gcp_probe_regions` / `azure_probe_regions`).
3. Add a matching `resource` + `import {}` block for the new resource(s) in
   `aws.tf` / `gcp.tf` / `azure.tf`, using the real resource id.
4. `terraform plan` — expect only the new resource(s) as `to import`, everything
   else `No changes`. Then `terraform apply`.

The secret values do **not** need to be re-fetched from anywhere per region — they
come from `secrets.auto.tfvars` locally (and the HCP variables for remote runs).

## Rotating secrets

1. Rotate the upstream secret (regenerate `PROBE_SECRET`, or the GitHub token).
2. Update `secrets.auto.tfvars` **and** the HCP workspace variable.
3. `terraform apply` to push the new value to every origin.
