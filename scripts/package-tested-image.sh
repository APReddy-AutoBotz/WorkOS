#!/usr/bin/env bash
# Package the image tested by CI. The output directory must be new.
set -euo pipefail
if [[ $# != 3 ]]; then
  echo "Usage: $0 IMAGE CHECKED_OUT_COMMIT NEW_DIRECTORY" >&2
  exit 2
fi
image=$1
revision=$2
out=$3
[[ "$revision" =~ ^[[:xdigit:]]{40}$ && "$(git rev-parse HEAD)" == "$revision" ]] || { echo "Source revision mismatch" >&2; exit 1; }
image_id=$(docker image inspect --format '{{.Id}}' "$image")
label=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")
[[ "$label" == "$revision" ]] || { echo "Container revision mismatch" >&2; exit 1; }
mkdir -- "$out"
# Read the installed production dependency tree without contacting a registry.
docker run --rm --network none "$image_id" npm sbom --offline --omit=dev --sbom-format=cyclonedx > "$out/npm-runtime.cdx.json"
node --input-type=module - "$out/npm-runtime.cdx.json" <<'NODE'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const bom=JSON.parse(readFileSync(process.argv[2],'utf8'));
const app=JSON.parse(readFileSync('package.json','utf8'));
assert.equal(bom.bomFormat,'CycloneDX');
assert.equal(bom.metadata.component.name,app.name);
assert.equal(bom.metadata.component.version,app.version);
assert.ok(bom.components.length>0 && bom.dependencies.length>0);
NODE
docker run --rm --network none "$image_id" apk info -v | LC_ALL=C sort > "$out/alpine-packages.txt"
test -s "$out/alpine-packages.txt"
docker save "$image_id" | gzip -1 > "$out/image.tar.gz"
(
  cd -- "$out"
  printf '%s\n' "$revision" > source-commit.txt
  printf '%s\n' "$image_id" > image-id.txt
  sha256sum image.tar.gz npm-runtime.cdx.json alpine-packages.txt source-commit.txt image-id.txt > SHA256SUMS
  sha256sum --check SHA256SUMS
  docker load --input image.tar.gz
)
