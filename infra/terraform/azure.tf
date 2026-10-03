provider "azurerm" {
  features {}
  subscription_id = var.azure_subscription_id
}

provider "azuread" {}

# Resource Group
resource "azurerm_resource_group" "cloudping_probe" {
  name     = "cloudping-probe"
  location = "australiaeast"
}

import {
  to = azurerm_resource_group.cloudping_probe
  id = "/subscriptions/${var.azure_subscription_id}/resourceGroups/cloudping-probe"
}

# App Service Plans (F1 Free tier per region)
resource "azurerm_service_plan" "probe" {
  for_each = toset(var.azure_probe_regions)

  name                = "cloudping-probe-plan-${each.key}"
  resource_group_name = azurerm_resource_group.cloudping_probe.name
  location            = each.key
  os_type             = "Linux"
  sku_name            = "F1"
}

import {
  for_each = toset(var.azure_probe_regions)
  to       = azurerm_service_plan.probe[each.key]
  id       = "/subscriptions/${var.azure_subscription_id}/resourceGroups/cloudping-probe/providers/Microsoft.Web/serverFarms/cloudping-probe-plan-${each.key}"
}

# Linux Web Apps (F1 Free tier per region)
resource "azurerm_linux_web_app" "probe" {
  for_each = toset(var.azure_probe_regions)

  name                                           = "cloudping-probe-${each.key}"
  resource_group_name                            = azurerm_resource_group.cloudping_probe.name
  location                                       = each.key
  service_plan_id                                = azurerm_service_plan.probe[each.key].id
  https_only                                     = false
  client_affinity_enabled                        = true
  ftp_publish_basic_authentication_enabled       = false
  webdeploy_publish_basic_authentication_enabled = false

  site_config {
    always_on        = false
    app_command_line = "node server.js"
    ftps_state       = "FtpsOnly"

    application_stack {
      node_version = "24-lts"
    }
  }

  app_settings = {
    PROBE_SECRET                   = var.probe_secret
    PROBE_ORIGIN_ID                = "azure-${each.key}"
    PROBE_ORIGIN_LABEL             = "Azure App Service (${each.key})"
    SCM_DO_BUILD_DURING_DEPLOYMENT = "false"
    WEBSITES_PORT                  = "8080"
  }

  lifecycle {
    ignore_changes = [
      tags,
      zip_deploy_file,
      site_config[0].ip_restriction_default_action,
      site_config[0].scm_ip_restriction_default_action
    ]
  }
}

import {
  for_each = toset(var.azure_probe_regions)
  to       = azurerm_linux_web_app.probe[each.key]
  id       = "/subscriptions/${var.azure_subscription_id}/resourceGroups/cloudping-probe/providers/Microsoft.Web/sites/cloudping-probe-${each.key}"
}

# Azure AD Application (Pipeline identity)
resource "azuread_application" "deploy" {
  display_name = "cloudping-github-deploy"
}

import {
  to = azuread_application.deploy
  id = "/applications/5e535e4b-cb61-45d1-b851-a6bf0cfe7262"
}

# Service Principal for Pipeline identity
resource "azuread_service_principal" "deploy" {
  client_id = azuread_application.deploy.client_id
}

import {
  to = azuread_service_principal.deploy
  id = "/servicePrincipals/0c4c9a24-585c-4eba-83b0-8180f17ac0d3"
}

# Federated Credential for GitHub Actions OIDC (main branch)
resource "azuread_application_federated_identity_credential" "github_main" {
  application_id = azuread_application.deploy.id
  display_name   = "github-main"
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = var.azure_oidc_subject
  audiences      = ["api://AzureADTokenExchange"]
}

import {
  to = azuread_application_federated_identity_credential.github_main
  id = "5e535e4b-cb61-45d1-b851-a6bf0cfe7262/federatedIdentityCredential/a76d6c50-4956-4d5d-9dcf-64dfb563ec72"
}

# Role Assignment: Website Contributor on Resource Group
resource "azurerm_role_assignment" "deployer_website_contributor" {
  scope                = azurerm_resource_group.cloudping_probe.id
  role_definition_name = "Website Contributor"
  principal_id         = azuread_service_principal.deploy.object_id
}

import {
  to = azurerm_role_assignment.deployer_website_contributor
  id = "/subscriptions/${var.azure_subscription_id}/resourceGroups/cloudping-probe/providers/Microsoft.Authorization/roleAssignments/0792522f-fd93-4224-a805-d76b12411256"
}
