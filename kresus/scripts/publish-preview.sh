#!/usr/bin/env bash
set -euo pipefail

# Use only artifacts from this run and publish after all three are present.
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
gh run download "$GITHUB_RUN_ID" --name kresus-linux-deb --dir "$work_dir/deb"
gh run download "$GITHUB_RUN_ID" --name kresus-windows-msi --dir "$work_dir/msi"
gh run download "$GITHUB_RUN_ID" --name kresus-windows-nsis --dir "$work_dir/nsis"
shopt -s nullglob
deb=("$work_dir"/deb/*.deb)
msi=("$work_dir"/msi/*.msi)
nsis=("$work_dir"/nsis/*-setup.exe)
if (( ${#deb[@]} != 1 || ${#msi[@]} != 1 || ${#nsis[@]} != 1 )); then
  echo "Expected exactly one Debian, MSI and NSIS installer." >&2
  exit 1
fi
gh release create "$PREVIEW_TAG" "${deb[@]}" "${msi[@]}" "${nsis[@]}" \
  --verify-tag --prerelease --latest=false \
  --title "Kresus — Préversion $PREVIEW_TAG" \
  --notes "Préversion destinée aux essais. Les installateurs Windows ne sont pas signés et Windows peut afficher un avertissement."
