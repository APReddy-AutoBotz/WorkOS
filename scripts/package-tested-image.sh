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
# npm validates root devDependency declarations even for an omit-dev install.
# Bind only the runtime declarations over the manifest in the disposable scanner container.
runtime_manifest=$(mktemp)
trap 'rm -f -- "$runtime_manifest"' EXIT
docker run --rm --network none "$image_id" node -e \
  "const p=require('./package.json'); delete p.devDependencies; process.stdout.write(JSON.stringify(p))" > "$runtime_manifest"
chmod 644 "$runtime_manifest"
docker run --rm --network none --mount "type=bind,source=$runtime_manifest,target=/app/package.json,readonly" \
  "$image_id" npm sbom --offline --omit=dev --sbom-format=cyclonedx > "$out/npm-runtime.cdx.json"
node --input-type=module - "$out/npm-runtime.cdx.json" <<'NODE'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const bom=JSON.parse(readFileSync(process.argv[2],'utf8'));
const app=JSON.parse(readFileSync('package.json','utf8'));
assert.equal(bom.bomFormat,'CycloneDX');
const rootRef=app.name+'@'+app.version;
assert.equal(bom.metadata.component['bom-ref'],rootRef);
assert.ok(bom.dependencies.some(edge=>edge.ref===rootRef && edge.dependsOn.length>0));
assert.equal(bom.metadata.component.version,app.version);
assert.ok(bom.components.length>0 && bom.dependencies.length>0);
NODE
docker run --rm --network none "$image_id" apk info -v | LC_ALL=C sort > "$out/alpine-packages.txt"
docker run --rm -i --network none "$image_id" node --input-type=module - \
  < scripts/image-third-party-notices.mjs > "$out/npm-third-party-notices.json"
test -s "$out/alpine-packages.txt"
docker save "$image_id" | gzip -1 > "$out/image.tar.gz"
(
  cd -- "$out"
  printf '%s\n' "$revision" > source-commit.txt
  printf '%s\n' "$image_id" > image-id.txt
  sha256sum image.tar.gz npm-runtime.cdx.json npm-third-party-notices.json alpine-packages.txt source-commit.txt image-id.txt > SHA256SUMS
  sha256sum --check SHA256SUMS
  docker load --input image.tar.gz
)
