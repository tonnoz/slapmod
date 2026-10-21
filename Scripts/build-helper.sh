#!/usr/bin/env bash
# Builds the slapsense helper for Apple Silicon, signs it and puts it at
# native/slapsense, the file the mod runs.
#
# Signing reads two settings from the environment, or from .env.local
# (gitignored; copy .env.example):
#   SLAPMOD_SIGN_IDENTITY   a "Developer ID Application" identity in your
#                           keychain; "-" (the default) signs ad hoc, for
#                           trying a build on your own Mac only
#   SLAPMOD_NOTARY_PROFILE  a notarytool keychain profile; set, the helper is
#                           notarized too, as a release needs
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env.local" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/.env.local"
fi
IDENTITY="${SLAPMOD_SIGN_IDENTITY:--}"
PROFILE="${SLAPMOD_NOTARY_PROFILE:-}"
SIGNING_ID="io.github.tonnoz.slapmod.slapsense"
PACKAGE="$ROOT/helper"
OUT="$ROOT/native/slapsense"

swift build -c release --arch arm64 --package-path "$PACKAGE"
BUILT="$(swift build -c release --arch arm64 --package-path "$PACKAGE" --show-bin-path)/slapsense"

mkdir -p "$(dirname "$OUT")"
cp "$BUILT" "$OUT"
# Debug symbols name the build machine's paths; none of that ships.
strip -S -x "$OUT"

if [[ "$IDENTITY" == "-" ]]; then
  codesign --force --options runtime --identifier "$SIGNING_ID" --sign - "$OUT"
  echo "Signed ad hoc: fine on this Mac, not for a release."
else
  codesign --force --options runtime --timestamp --identifier "$SIGNING_ID" --sign "$IDENTITY" "$OUT"
fi
codesign --verify --strict "$OUT"

if [[ -n "$PROFILE" ]]; then
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  ditto -c -k --keepParent "$OUT" "$WORK/slapsense.zip"
  xcrun notarytool submit "$WORK/slapsense.zip" --keychain-profile "$PROFILE" --wait
fi

echo "native/slapsense $("$OUT" --version)"
