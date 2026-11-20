#!/usr/bin/env bash
set -euo pipefail

# Prerequisites: log in to GHCR with a token carrying write:packages.
# gh auth refresh -s write:packages
# gh auth token | docker login ghcr.io -u <user> --password-stdin
# The GitHub Actions workflow is the normal release path; this script is the manual fallback.
# Run this from a clean checkout at the v<version> release tag.

if [[ $# -ne 1 || ! $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: scripts/release-image.sh <version>" >&2
  exit 2
fi

version=$1
platforms=${PLATFORMS:-linux/amd64,linux/arm64}
if [[ -n $(git status --porcelain) ]]; then
  echo "refusing release: working tree is not clean" >&2
  exit 1
fi

revision=$(git rev-parse HEAD)
tag_revision=$(git rev-parse -q --verify "refs/tags/v${version}^{commit}") || {
  echo "refusing release: tag v${version} does not exist" >&2
  exit 1
}
if [[ $revision != "$tag_revision" ]]; then
  echo "refusing release: HEAD is not tag v${version}" >&2
  exit 1
fi

tags=(--tag "ghcr.io/dottio123/ferricade:${version}")
if [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  tags+=(--tag "ghcr.io/dottio123/ferricade:latest")
fi

build_command=(docker buildx build --platform "$platforms" --push "${tags[@]}"
  --build-arg "VERSION=${version}"
  --label "org.opencontainers.image.source=https://github.com/dottio123/ferricade"
  --label "org.opencontainers.image.version=${version}"
  --label "org.opencontainers.image.revision=${revision}"
  --label "org.opencontainers.image.title=ferricade"
  .)

if [[ ${RELEASE_DRY_RUN:-0} == 1 ]]; then
  printf '%q ' "${build_command[@]}"
  printf '\n'
  exit 0
fi

"${build_command[@]}"
