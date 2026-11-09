#!/usr/bin/env bash
# User-space install (no sudo) of oc (+kubectl) and crc into ~/bin. `oc kustomize` replaces a separate kustomize.
set -euo pipefail
BIN=${BIN:-$HOME/bin}; mkdir -p "$BIN"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
if ! command -v oc >/dev/null; then
  curl -fsSL https://mirror.openshift.com/pub/openshift-v4/clients/ocp/stable/openshift-client-linux.tar.gz -o "$T/oc.tgz"
  tar -xzf "$T/oc.tgz" -C "$BIN" oc kubectl
fi
if ! command -v crc >/dev/null; then
  curl -fsSL https://developers.redhat.com/content-gateway/rest/mirror/pub/openshift-v4/clients/crc/latest/crc-linux-amd64.tar.xz -o "$T/crc.txz"
  tar -xJf "$T/crc.txz" -C "$T" --strip-components=1 && install -m 755 "$T/crc" "$BIN/crc"
fi
echo "installed to $BIN (add to PATH if needed): $(ls "$BIN" | tr '\n' ' ')"
echo "next: crc config set preset okd && crc config set memory 16384 && crc setup && crc start"
