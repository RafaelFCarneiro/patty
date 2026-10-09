#!/usr/bin/env bash
# Prints `true` when the diff between <base> and <head> touches anything the container image is built from or
# tested with, else `false`. Lets the PR Docker job skip itself for changes that cannot affect the image.
# Usage: scripts/container-files-changed.sh <base-sha> [head-ref]   (head defaults to HEAD)
set -euo pipefail

BASE="${1:?usage: container-files-changed.sh <base-sha> [head-ref]}"
HEAD_REF="${2:-HEAD}"

# What the Dockerfile COPYs (package files, tsconfig*, src, drizzle, ui, skills), the Dockerfile and its
# context rules, compose.yaml, the smoke test, and the CI plumbing that builds the image.
CONTAINER_PATHS=(
  Dockerfile
  .dockerignore
  compose.yaml
  package.json
  package-lock.json
  'tsconfig*.json'
  src
  drizzle
  ui
  skills
  scripts/docker-smoke.sh
  scripts/container-files-changed.sh
  .github/actions/base-image
  .github/workflows/ci.yml
  .github/workflows/mirror-base-image.yml
)

if [ -n "$(git diff --name-only "$BASE" "$HEAD_REF" -- "${CONTAINER_PATHS[@]}")" ]; then
  echo true
else
  echo false
fi
