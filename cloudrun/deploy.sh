#!/usr/bin/env bash
# Deploy the cloudping probe to one or more GCP Cloud Run regions.
#
# Parity with the AWS Lambda origins: same runProbe code, 300s timeout,
# min-instances 0, ~256MB-equivalent (512Mi / 0.5 vCPU is Cloud Run's floor for
# reliable cold starts). Each region self-labels via PROBE_ORIGIN_ID=gcp-<region>.
#
# BUILD-ONCE, DEPLOY-EVERYWHERE: a no-billing GCP project can only run Cloud Build
# in a limited set of regions ("unable to run builds in this region"). So we build
# the image exactly once (in BUILD_REGION, or reuse an existing image) and every
# region deploys that same prebuilt image via --image. This sidesteps per-region
# build quota entirely and guarantees all GCP origins run identical bytes.
#
# BUILD_REGION defaults to asia-northeast3 (Seoul): Artifact Registry storage costs
# the same in every region (free under 0.5GB), so region choice is about where
# builds are allowed on this no-billing project + colocation with a Cloud Run
# origin (Seoul is one) to minimize image-pull egress on any future paid tier.
# Priority: us-west1 (pending a Cloud Build quota support ticket) > Seoul/East-Asia.
#
# Prereqs: gcloud auth, PROBE_SECRET exported, project set.
# Usage:   PROBE_SECRET=xxx ./cloudrun/deploy.sh asia-northeast3 us-west1 ...
#   BUILD_REGION=asia-northeast3  # region used for the one-time build (default)
#   REBUILD=1                     # force a fresh build even if an image exists
set -euo pipefail

SERVICE="cloudping-probe"
BUILD_REGION="${BUILD_REGION:-asia-northeast3}"
: "${PROBE_SECRET:?export PROBE_SECRET first}"
if [ "$#" -eq 0 ]; then echo "usage: PROBE_SECRET=xxx $0 <region> [region ...]" >&2; exit 1; fi

project="$(gcloud config get-value project 2>/dev/null)"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The image lives in the BUILD_REGION Artifact Registry repo that Cloud Run's
# source deploys create (cloud-run-source-deploy). All regions can pull it.
IMAGE="${BUILD_REGION}-docker.pkg.dev/${project}/cloud-run-source-deploy/${SERVICE}:latest"

image_exists() {
  gcloud artifacts docker images describe "${IMAGE}" >/dev/null 2>&1
}

build_image() {
  local build_dir
  build_dir="$(mktemp -d)"
  trap 'rm -rf "${build_dir}"' RETURN
  echo "Bundling server with esbuild..."
  npx --yes esbuild "${repo_root}/cloudrun/server.ts" \
    --bundle --platform=node --target=node24 --format=cjs \
    --alias:@app/data="${repo_root}/src/data" \
    --outfile="${build_dir}/server.js" >/dev/null
  cp "${repo_root}/cloudrun/Dockerfile" "${build_dir}/Dockerfile"
  echo "Building the shared image once in ${BUILD_REGION} (source build)..."
  # A source deploy in the build region both builds+pushes the image and creates
  # the cloud-run-source-deploy repo. We then reuse IMAGE for every region.
  gcloud run deploy "${SERVICE}" \
    --source "${build_dir}" \
    --region "${BUILD_REGION}" \
    --no-allow-unauthenticated \
    --cpu 0.5 --memory 512Mi --timeout 300 --no-cpu-boost \
    --min-instances 0 --max-instances 1 \
    --set-env-vars "PROBE_SECRET=${PROBE_SECRET},PROBE_ORIGIN_ID=gcp-${BUILD_REGION},PROBE_ORIGIN_LABEL=GCP Cloud Run (${BUILD_REGION})" \
    --quiet
}

# Build once (or reuse). REBUILD=1 forces a fresh build.
if [ "${REBUILD:-0}" = "1" ] || ! image_exists; then
  build_image
else
  echo "Reusing existing shared image: ${IMAGE}"
fi

for region in "$@"; do
  echo ""
  echo "=== ${region} ==="
  gcloud run deploy "${SERVICE}" \
    --image "${IMAGE}" \
    --region "${region}" \
    --no-allow-unauthenticated \
    --cpu 0.5 --memory 512Mi --timeout 300 --no-cpu-boost \
    --min-instances 0 --max-instances 1 \
    --set-env-vars "PROBE_SECRET=${PROBE_SECRET},PROBE_ORIGIN_ID=gcp-${region},PROBE_ORIGIN_LABEL=GCP Cloud Run (${region})" \
    --quiet
  url="$(gcloud run services describe "${SERVICE}" --region "${region}" --format='value(status.url)')"
  echo "Service URL: ${url}"
done

echo ""
echo "All GCP regions deployed from the single shared image: ${IMAGE}"
