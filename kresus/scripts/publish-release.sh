#!/usr/bin/env bash
set -euo pipefail

signing_notes="Les installateurs Windows ne sont pas signés. L’application macOS universelle est signée ad hoc et n’est pas notariée par Apple. Windows et macOS peuvent afficher un avertissement à l’installation ou au premier lancement."
if [[ "$RELEASE_TAG" == preview-* ]]; then
  release_options=(--prerelease --latest=false --title "Kresus — Préversion $RELEASE_TAG"
    --notes "Préversion destinée aux essais. $signing_notes")
elif [[ "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  python3 - "$(dirname "$0")/.." "${RELEASE_TAG#v}" <<'PY'
import json
import sys
import tomllib
from pathlib import Path

project = Path(sys.argv[1])
version = sys.argv[2]
for manifest in ("package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml"):
    source = (project / manifest).read_text(encoding="utf-8")
    config = tomllib.loads(source)["package"] if manifest.endswith(".toml") else json.loads(source)
    if config["version"] != version:
        sys.exit(f"Tag v{version} does not match {manifest} ({config['version']}).")
PY
  release_options=(--draft --title "Kresus $RELEASE_TAG" --generate-notes --notes "$signing_notes")
else
  echo "Expected a preview-* or vMAJOR.MINOR.PATCH release tag." >&2
  exit 1
fi

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
gh release create "$RELEASE_TAG" "${deb[@]}" "${msi[@]}" "${nsis[@]}" "${dmg[@]}" \
  --verify-tag "${release_options[@]}"
