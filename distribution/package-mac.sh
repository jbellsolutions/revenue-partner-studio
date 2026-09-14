#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ $(uname -s) == Darwin ]]
arch=$(uname -m)
folder=mac
[[ "$arch" != arm64 ]] || folder=mac-arm64
app="apps/desktop/release/$folder/Revenue Partner Studio.app"
codesign --verify --deep --strict "$app"
mkdir -p .studio/release
version=$(node -p "JSON.parse(require('fs').readFileSync('apps/desktop/package.json')).version")
artifact="Revenue-Partner-Studio-$version-mac-$arch.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" ".studio/release/$artifact"
(cd .studio/release && shasum -a 256 "$artifact" > "$artifact.sha256")
printf '%s\n' ".studio/release/$artifact"
