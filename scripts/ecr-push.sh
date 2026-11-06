#!/usr/bin/env bash
# Build the Atlas images and push them to Amazon ECR.
#   ./scripts/ecr-push.sh                    build + push backend, frontend and admin
#   ./scripts/ecr-push.sh backend frontend   build + push only the services named
#
# Settings (environment variables):
#   AWS_REGION     ECR region (default: ap-south-1)
#   AWS_ACCOUNT_ID expected AWS account (default: 358727392153); the script stops if your credentials differ
#   AWS_PROFILE    AWS CLI profile to use (optional)
#   ECR_PREFIX     repository name prefix (default: atlas  ->  atlas-backend, atlas-frontend, atlas-admin)
#   IMAGE_TAG      extra tag to push (default: current git short SHA); "latest" is always pushed too
#   PLATFORM       target platform (default: linux/amd64, what most ECS/EC2/Fargate hosts run)
#
# Frontend build args (NEXT_PUBLIC_* are baked in at build time, so set them for the deployed URLs):
#   BACKEND_URL, NEXT_PUBLIC_ADMIN_URL, NEXT_PUBLIC_SEPOLIA_RPC_URL, NEXT_PUBLIC_DEMO_WORLD_ID,
#   NEXT_PUBLIC_DEMO_WALLET, NEXT_PUBLIC_INTENT_DEMO_MODE, NEXT_PUBLIC_ARKIV_EXPLORER_URL
#   Values in frontend/.env.local are used when not set in the environment.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v aws >/dev/null    || { echo "AWS CLI is not installed." >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is not installed." >&2; exit 1; }
docker info >/dev/null 2>&1  || { echo "Docker is not running. Start Docker Desktop and retry." >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "docker buildx is required." >&2; exit 1; }

ALL_SERVICES=(backend frontend admin)
SERVICES=("$@")
[ ${#SERVICES[@]} -eq 0 ] && SERVICES=("${ALL_SERVICES[@]}")
for s in "${SERVICES[@]}"; do
  case "$s" in backend|frontend|admin) ;; *) echo "Unknown service: $s (use: ${ALL_SERVICES[*]})" >&2; exit 1 ;; esac
done

AWS_REGION="${AWS_REGION:-ap-south-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-358727392153}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)" \
  || { echo "AWS credentials are not configured (run 'aws configure' or 'aws sso login')." >&2; exit 1; }
if [ "$ACCOUNT_ID" != "$AWS_ACCOUNT_ID" ]; then
  echo "Your AWS credentials are for account $ACCOUNT_ID, but the Atlas repos live in $AWS_ACCOUNT_ID." >&2
  echo "Switch profile (AWS_PROFILE=...) or set AWS_ACCOUNT_ID=$ACCOUNT_ID to push there instead." >&2
  exit 1
fi
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
ECR_PREFIX="${ECR_PREFIX:-atlas}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
PLATFORM="${PLATFORM:-linux/amd64}"

# Reuse NEXT_PUBLIC_* from frontend/.env.local, without overriding values already in the environment.
if [ -f frontend/.env.local ]; then
  while IFS='=' read -r key value; do
    [ -z "${!key:-}" ] && export "$key=$value"
  done < <(grep -E '^NEXT_PUBLIC_[A-Z_]+=' frontend/.env.local)
fi

echo "Registry: $REGISTRY   Tags: $IMAGE_TAG, latest   Platform: $PLATFORM"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

for svc in "${SERVICES[@]}"; do
  repo="${ECR_PREFIX}-${svc}"
  if ! aws ecr describe-repositories --region "$AWS_REGION" --repository-names "$repo" >/dev/null 2>&1; then
    echo "Creating ECR repository $repo"
    aws ecr create-repository --region "$AWS_REGION" --repository-name "$repo" \
      --image-scanning-configuration scanOnPush=true >/dev/null
  fi

  build_args=()
  if [ "$svc" = frontend ]; then
    for var in BACKEND_URL NEXT_PUBLIC_ADMIN_URL NEXT_PUBLIC_SEPOLIA_RPC_URL NEXT_PUBLIC_DEMO_WORLD_ID \
               NEXT_PUBLIC_DEMO_WALLET NEXT_PUBLIC_INTENT_DEMO_MODE NEXT_PUBLIC_ARKIV_EXPLORER_URL; do
      [ -n "${!var:-}" ] && build_args+=(--build-arg "$var=${!var}")
    done
  fi

  echo "==> Building and pushing $repo"
  docker buildx build \
    --platform "$PLATFORM" \
    -f "$svc/Dockerfile" \
    ${build_args[@]+"${build_args[@]}"} \
    -t "$REGISTRY/$repo:$IMAGE_TAG" \
    -t "$REGISTRY/$repo:latest" \
    --push .
done

echo
echo "Pushed:"
for svc in "${SERVICES[@]}"; do
  echo "  $REGISTRY/${ECR_PREFIX}-${svc}:$IMAGE_TAG"
done
