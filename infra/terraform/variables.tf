variable "aws_account_id" {
  type        = string
  description = "AWS Account ID"
  default     = "090451331601"
}

variable "aws_default_region" {
  type        = string
  description = "Default AWS region for provider and singletons (clock lambda, eventbridge)"
  default     = "ap-northeast-2"
}

variable "aws_probe_regions" {
  type        = list(string)
  description = "List of AWS regions where cloudping-probe Lambda is deployed"
  default = [
    "af-south-1",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-south-1",
    "ap-southeast-1",
    "ap-southeast-2",
    "eu-central-1",
    "eu-west-1",
    "me-central-1",
    "sa-east-1",
    "us-east-1",
    "us-east-2",
    "us-west-2"
  ]
}

variable "gcp_project_id" {
  type        = string
  description = "GCP Project ID"
  default     = "froguin3"
}

variable "gcp_default_region" {
  type        = string
  description = "Default GCP region"
  default     = "asia-northeast1"
}

variable "gcp_probe_regions" {
  type        = list(string)
  description = "List of GCP regions where cloudping-probe Cloud Run is deployed"
  default = [
    "asia-northeast1",
    "asia-northeast3",
    "asia-south1",
    "europe-west1",
    "southamerica-east1",
    "us-west1"
  ]
}

variable "azure_subscription_id" {
  type        = string
  description = "Azure Subscription ID"
  default     = "b399bb18-0873-460b-a8bd-8b51f8a75ada"
}

variable "azure_probe_regions" {
  type        = list(string)
  description = "List of Azure regions where cloudping-probe App Service is deployed"
  default = [
    "australiacentral",
    "brazilsouth",
    "canadacentral",
    "eastus2",
    "israelcentral",
    "japaneast",
    "koreacentral",
    "southafricanorth",
    "southeastasia",
    "westeurope",
    "westindia"
  ]
}

variable "github_repo" {
  type        = string
  description = "GitHub repo slug (owner/name) for the GCP WIF repository claim and the clock Lambda workflow_dispatch target. Plaintext, non-secret. Change this when transferring the repo to a new owner."
  default     = "cloudpickr/cloudping.me"
}

# AWS/Azure OIDC subject strings are kept as full-string variables rather than
# derived from github_repo. As of GitHub's July 15, 2026 change, transferring or
# renaming a repo switches the OIDC `sub` claim to the immutable format
# `repo:<owner>@<OWNER_ID>/<name>@<REPO_ID>:ref:refs/heads/main`, so the subject
# can no longer be reconstructed from the slug alone. At transfer time, look up
# the new subject (GitHub OIDC settings "preview" endpoint, or the token claim
# after transfer) and set these two variables, then `terraform apply`. The GCP
# `assertion.repository` / `attribute.repository` claims are unaffected and keep
# using github_repo. See infra/terraform/README.md.
variable "aws_oidc_subject" {
  type        = string
  description = "Full GitHub Actions OIDC `sub` claim trusted by the AWS deployer/invoker IAM roles. Post-2026-07-15 transfers use the immutable form repo:<owner>@<OWNER_ID>/<name>@<REPO_ID>:ref:refs/heads/main."
  default     = "repo:cloudpickr@80160794/cloudping.me@1227660849:ref:refs/heads/main"
}

variable "azure_oidc_subject" {
  type        = string
  description = "Full GitHub Actions OIDC `sub` claim trusted by the Azure AD federated credential. Post-2026-07-15 transfers use the immutable form repo:<owner>@<OWNER_ID>/<name>@<REPO_ID>:ref:refs/heads/main."
  default     = "repo:cloudpickr@80160794/cloudping.me@1227660849:ref:refs/heads/main"
}

variable "probe_secret" {
  type        = string
  description = "Bearer secret for cloudping probes (set via HCP workspace variable, sensitive)"
  sensitive   = true
}

variable "github_dispatch_token" {
  type        = string
  description = "GitHub token the clock Lambda uses to workflow_dispatch probe.yml (set via HCP workspace variable, sensitive)"
  sensitive   = true
}
