#!/usr/bin/env bash
set -euo pipefail

# Use only artifacts from this run and publish after all installers are present.
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
gh run download "$GITHUB_RUN_ID" --name kresus-linux-deb --dir "$work_dir/deb"
gh run download "$GITHUB_RUN_ID" --name kresus-windows-msi --dir "$work_dir/msi"
gh run download "$GITHUB_RUN_ID" --name kresus-windows-nsis --dir "$work_dir/nsis"
gh run download "$GITHUB_RUN_ID" --name kresus-macos-dmg --dir "$work_dir/dmg"
shopt -s nullglob
deb=("$work_dir"/deb/*.deb)
msi=("$work_dir"/msi/*.msi)
nsis=("$work_dir"/nsis/*-setup.exe)
dmg=("$work_dir"/dmg/*.dmg)
if (( ${#deb[@]} != 1 || ${#msi[@]} != 1 || ${#nsis[@]} != 1 || ${#dmg[@]} != 1 )); then
  echo "Expected exactly one Debian package, MSI installer, NSIS installer and macOS disk image." >&2
  exit 1
fi
gh release create "$PREVIEW_TAG" "${deb[@]}" "${msi[@]}" "${nsis[@]}" "${dmg[@]}" \
  --verify-tag --prerelease --latest=false \
  --title "Kresus — Préversion $PREVIEW_TAG" \
  --notes "Préversion destinée aux essais. Les installateurs Windows ne sont pas signés. L’application macOS universelle est signée ad hoc et n’est pas notariée par Apple. Windows et macOS peuvent afficher un avertissement à l’installation ou au premier lancement."
