#!/usr/bin/env bash
# Point a floating ECR tag at an image that is already in the repository —
# no rebuild, no pull: the target tag gets the source tag's exact manifest.
#
#   promote-image.sh <repository> <source-tag> <target-tag>
#
# Why it exists: the deploy workflows build the image IN PARALLEL with the test
# gate, so the build may only push an immutable tag (`:<sha>`). The floating tag
# ECS actually runs (`:latest`, `:production`) moves here, after
# the tests have passed — a red test run never leaves untested code on a tag a
# task restart could pick up.
#
# Needs ecr:BatchGetImage + ecr:PutImage on the repository (the shared deploy
# policy, infra/terraform/envs/staging/github-deploy.tf).
set -euo pipefail

repo="$1"
src="$2"
dst="$3"

image=$(aws ecr batch-get-image --repository-name "$repo" --image-ids imageTag="$src" \
  --query 'images[0].[imageManifest,imageManifestMediaType]' --output json --no-cli-pager)
manifest=$(jq -r '.[0] // empty' <<<"$image")
media=$(jq -r '.[1] // empty' <<<"$image")

if [ -z "$manifest" ]; then
  echo "::error::No image tagged '$src' in $repo — the build job should have pushed it."
  exit 1
fi

# Re-pointing a tag at the manifest it already has is refused by ECR
# (ImageAlreadyExistsException) — that is a no-op, not a failure: a re-run of
# the same commit.
if out=$(aws ecr put-image --repository-name "$repo" --image-tag "$dst" \
  --image-manifest "$manifest" --image-manifest-media-type "$media" --no-cli-pager 2>&1); then
  echo "promoted $repo:$src -> :$dst"
elif grep -q ImageAlreadyExistsException <<<"$out"; then
  echo "$repo:$dst already points at :$src"
else
  echo "$out" >&2
  exit 1
fi
