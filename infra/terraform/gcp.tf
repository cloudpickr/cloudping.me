provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_default_region
}

# Artifact Registry Repository (cloud-run-source-deploy in asia-northeast3)
resource "google_artifact_registry_repository" "cloud_run_source_deploy" {
  location      = "asia-northeast3"
  repository_id = "cloud-run-source-deploy"
  format        = "DOCKER"
  project       = var.gcp_project_id
}

import {
  to = google_artifact_registry_repository.cloud_run_source_deploy
  id = "projects/${var.gcp_project_id}/locations/asia-northeast3/repositories/cloud-run-source-deploy"
}

# Workload Identity Federation Pool
resource "google_iam_workload_identity_pool" "github_pool" {
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions pool"
  project                   = var.gcp_project_id
}

import {
  to = google_iam_workload_identity_pool.github_pool
  id = "projects/${var.gcp_project_id}/locations/global/workloadIdentityPools/github-pool"
}

# Workload Identity Federation Provider (cloudping-provider)
resource "google_iam_workload_identity_pool_provider" "cloudping_provider" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_pool.workload_identity_pool_id
  workload_identity_pool_provider_id = "cloudping-provider"
  display_name                       = "cloudping GitHub OIDC"
  project                            = var.gcp_project_id
  attribute_condition                = "assertion.repository=='${var.github_repo}'"

  attribute_mapping = {
    "attribute.ref"        = "assertion.ref"
    "attribute.repository" = "assertion.repository"
    "google.subject"       = "assertion.sub"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

import {
  to = google_iam_workload_identity_pool_provider.cloudping_provider
  id = "projects/${var.gcp_project_id}/locations/global/workloadIdentityPools/github-pool/providers/cloudping-provider"
}

# Service Account: cloudping-deployer (GitHub Actions pipeline deployer)
resource "google_service_account" "cloudping_deployer" {
  account_id   = "cloudping-deployer"
  display_name = "cloudping GCP deployer (GitHub Actions)"
  project      = var.gcp_project_id
}

import {
  to = google_service_account.cloudping_deployer
  id = "projects/${var.gcp_project_id}/serviceAccounts/cloudping-deployer@${var.gcp_project_id}.iam.gserviceaccount.com"
}

# Service Account: cloudping-invoker (GitHub Actions probe runner invoker)
resource "google_service_account" "cloudping_invoker" {
  account_id   = "cloudping-invoker"
  display_name = "cloudping probe invoker (GitHub OIDC)"
  project      = var.gcp_project_id
}

import {
  to = google_service_account.cloudping_invoker
  id = "projects/${var.gcp_project_id}/serviceAccounts/cloudping-invoker@${var.gcp_project_id}.iam.gserviceaccount.com"
}

# Service Account IAM: cloudping-deployer WIF binding
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.cloudping_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/985711852190/locations/global/workloadIdentityPools/github-pool/attribute.repository/${var.github_repo}"
}

import {
  to = google_service_account_iam_member.deployer_wif
  id = "projects/${var.gcp_project_id}/serviceAccounts/cloudping-deployer@${var.gcp_project_id}.iam.gserviceaccount.com roles/iam.workloadIdentityUser principalSet://iam.googleapis.com/projects/985711852190/locations/global/workloadIdentityPools/github-pool/attribute.repository/${var.github_repo}"
}

# Service Account IAM: cloudping-invoker WIF binding
resource "google_service_account_iam_member" "invoker_wif" {
  service_account_id = google_service_account.cloudping_invoker.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/985711852190/locations/global/workloadIdentityPools/github-pool/attribute.repository/${var.github_repo}"
}

import {
  to = google_service_account_iam_member.invoker_wif
  id = "projects/${var.gcp_project_id}/serviceAccounts/cloudping-invoker@${var.gcp_project_id}.iam.gserviceaccount.com roles/iam.workloadIdentityUser principalSet://iam.googleapis.com/projects/985711852190/locations/global/workloadIdentityPools/github-pool/attribute.repository/${var.github_repo}"
}

# Service Account IAM: cloudping-invoker token creator binding
resource "google_service_account_iam_member" "invoker_token_creator" {
  service_account_id = google_service_account.cloudping_invoker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.cloudping_invoker.email}"
}

import {
  to = google_service_account_iam_member.invoker_token_creator
  id = "projects/${var.gcp_project_id}/serviceAccounts/cloudping-invoker@${var.gcp_project_id}.iam.gserviceaccount.com roles/iam.serviceAccountTokenCreator serviceAccount:cloudping-invoker@${var.gcp_project_id}.iam.gserviceaccount.com"
}

# Project IAM: cloudping-deployer -> roles/artifactregistry.writer
resource "google_project_iam_member" "deployer_ar_writer" {
  project = var.gcp_project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.cloudping_deployer.email}"
}

import {
  to = google_project_iam_member.deployer_ar_writer
  id = "${var.gcp_project_id} roles/artifactregistry.writer serviceAccount:cloudping-deployer@${var.gcp_project_id}.iam.gserviceaccount.com"
}

# Project IAM: cloudping-deployer -> roles/iam.serviceAccountUser
resource "google_project_iam_member" "deployer_sa_user" {
  project = var.gcp_project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.cloudping_deployer.email}"
}

import {
  to = google_project_iam_member.deployer_sa_user
  id = "${var.gcp_project_id} roles/iam.serviceAccountUser serviceAccount:cloudping-deployer@${var.gcp_project_id}.iam.gserviceaccount.com"
}

# Project IAM: cloudping-deployer -> roles/run.admin
resource "google_project_iam_member" "deployer_run_admin" {
  project = var.gcp_project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.cloudping_deployer.email}"
}

import {
  to = google_project_iam_member.deployer_run_admin
  id = "${var.gcp_project_id} roles/run.admin serviceAccount:cloudping-deployer@${var.gcp_project_id}.iam.gserviceaccount.com"
}

# Cloud Run v2 Services across the 6 GCP regions
resource "google_cloud_run_v2_service" "probe" {
  for_each = toset(var.gcp_probe_regions)

  name     = "cloudping-probe"
  location = each.key
  project  = var.gcp_project_id
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    timeout = "300s"

    scaling {
      max_instance_count = 1
      min_instance_count = 0
    }

    containers {
      image = "asia-northeast3-docker.pkg.dev/froguin3/cloud-run-source-deploy/cloudping-probe:9f5c7f959a0d5b940fd1bda7027052916da2863c"

      resources {
        limits = {
          cpu    = "0.5"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "PROBE_SECRET"
        value = var.probe_secret
      }
      env {
        name  = "PROBE_ORIGIN_ID"
        value = "gcp-${each.key}"
      }
      env {
        name  = "PROBE_ORIGIN_LABEL"
        value = "GCP Cloud Run (${each.key})"
      }
    }
  }

  lifecycle {
    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image,
      build_config,
      scaling
    ]
  }
}

import {
  for_each = toset(var.gcp_probe_regions)
  to       = google_cloud_run_v2_service.probe[each.key]
  id       = "projects/${var.gcp_project_id}/locations/${each.key}/services/cloudping-probe"
}

# Cloud Run IAM Member: cloudping-invoker -> roles/run.invoker
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = toset(var.gcp_probe_regions)

  project  = var.gcp_project_id
  location = each.key
  name     = google_cloud_run_v2_service.probe[each.key].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.cloudping_invoker.email}"
}

import {
  for_each = toset(var.gcp_probe_regions)
  to       = google_cloud_run_v2_service_iam_member.invoker[each.key]
  id       = "projects/${var.gcp_project_id}/locations/${each.key}/services/cloudping-probe roles/run.invoker serviceAccount:${google_service_account.cloudping_invoker.email}"
}
