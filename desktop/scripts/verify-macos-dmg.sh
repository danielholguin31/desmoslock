#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ $# -ne 2 ]]; then
  fail "usage: $0 <dmg-path> <arm64|x86_64>"
fi

dmg_input=$1
expected_arch=$2

case "$expected_arch" in
  arm64|x86_64) ;;
  *) fail "expected architecture must be arm64 or x86_64 (received: $expected_arch)" ;;
esac

[[ -f "$dmg_input" ]] || fail "DMG does not exist or is not a regular file: $dmg_input"
[[ -r "$dmg_input" ]] || fail "DMG is not readable: $dmg_input"

for command_name in hdiutil lipo codesign xcrun syspolicy_check spctl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done
[[ -x /usr/libexec/PlistBuddy ]] || fail "required command is unavailable: /usr/libexec/PlistBuddy"

dmg_dir=$(cd "$(dirname "$dmg_input")" && pwd -P)
dmg="$dmg_dir/$(basename "$dmg_input")"

printf 'Verifying DMG container: %s\n' "$dmg"
hdiutil verify "$dmg" || fail "hdiutil verification failed for $dmg"

temp_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
temp_root=$(mktemp -d "$temp_parent/desmoslock-verify.XXXXXX") || \
  fail "could not create a temporary directory under $temp_parent"
case "$temp_root" in
  "$temp_parent"/desmoslock-verify.*) ;;
  *) fail "refusing unexpected temporary path: $temp_root" ;;
esac

mount_point="$temp_root/mount"
mkdir "$mount_point"
mounted=0

cleanup() {
  cleanup_status=$?
  trap - EXIT HUP INT TERM

  if [[ $mounted -eq 1 ]]; then
    if ! hdiutil detach "$mount_point"; then
      printf 'ERROR: failed to detach DMG mounted at %s\n' "$mount_point" >&2
      [[ $cleanup_status -ne 0 ]] || cleanup_status=1
    fi
  fi

  rmdir "$mount_point" 2>/dev/null || true
  rmdir "$temp_root" 2>/dev/null || true
  exit "$cleanup_status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Mounting read-only at validated temporary path: %s\n' "$mount_point"
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount_point" "$dmg" >/dev/null || \
  fail "could not mount $dmg read-only"
mounted=1

apps=()
while IFS= read -r -d '' app_path; do
  apps+=("$app_path")
done < <(find "$mount_point" -type d -name 'DesmosLock.app' -prune -print0)

if [[ ${#apps[@]} -ne 1 ]]; then
  fail "expected exactly one DesmosLock.app in the DMG; found ${#apps[@]}"
fi
app=${apps[0]}

info_plist="$app/Contents/Info.plist"
[[ -f "$info_plist" ]] || fail "application Info.plist is missing: $info_plist"
bundle_executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$info_plist" 2>/dev/null) || \
  fail "CFBundleExecutable is missing from $info_plist"
[[ "$bundle_executable" != */* ]] || \
  fail "CFBundleExecutable contains an unexpected path: $bundle_executable"
executable="$app/Contents/MacOS/$bundle_executable"
[[ -f "$executable" && -x "$executable" ]] || \
  fail "application executable is missing or not executable: $executable"

actual_archs=$(lipo -archs "$executable" 2>/dev/null) || \
  fail "could not inspect executable architecture: $executable"
actual_archs=$(printf '%s' "$actual_archs" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
[[ "$actual_archs" == "$expected_arch" ]] || \
  fail "expected a thin $expected_arch executable, but found: $actual_archs"
printf 'Executable architecture: %s\n' "$actual_archs"

trust_failures=0
record_trust_failure() {
  printf 'ERROR: %s\n' "$*" >&2
  trust_failures=$((trust_failures + 1))
}

set +e
codesign --verify --deep --strict --verbose=2 "$app"
codesign_status=$?
set -e
if [[ $codesign_status -ne 0 ]]; then
  record_trust_failure "strict code-signature verification failed (exit $codesign_status)"
fi

set +e
signature_info=$(codesign --display --verbose=4 "$app" 2>&1)
display_status=$?
set -e
printf '%s\n' "$signature_info"
if [[ $display_status -ne 0 ]]; then
  record_trust_failure "could not inspect the application signature (exit $display_status)"
fi

if ! printf '%s\n' "$signature_info" | grep -Eq '^Authority=Developer ID Application:.+'; then
  record_trust_failure "signature is not issued to a Developer ID Application identity"
fi

team_identifier=$(printf '%s\n' "$signature_info" | sed -n 's/^TeamIdentifier=//p' | head -n 1)
if [[ ! "$team_identifier" =~ ^[A-Z0-9]{10}$ ]]; then
  record_trust_failure "signature has no valid TeamIdentifier"
fi

if ! printf '%s\n' "$signature_info" | grep -q '^CodeDirectory .*flags=.*runtime'; then
  record_trust_failure "signature does not enable the hardened-runtime flag"
fi

secure_timestamp=$(printf '%s\n' "$signature_info" | sed -n 's/^Timestamp=//p' | head -n 1)
if [[ -z "$secure_timestamp" || "$secure_timestamp" == "none" ]] || \
   ! [[ "$secure_timestamp" =~ [0-9] ]]; then
  record_trust_failure "signature has no secure timestamp"
fi

set +e
xcrun stapler validate "$app"
stapler_status=$?
set -e
if [[ $stapler_status -ne 0 ]]; then
  record_trust_failure "the notarization ticket is missing or invalid (exit $stapler_status)"
fi

set +e
syspolicy_output=$(syspolicy_check distribution "$app" 2>&1)
syspolicy_status=$?
set -e
printf '%s\n' "$syspolicy_output"
if [[ $syspolicy_status -ne 0 ]]; then
  record_trust_failure "syspolicy_check rejected the application (exit $syspolicy_status)"
fi

set +e
spctl_output=$(spctl --assess --type execute --verbose=4 "$app" 2>&1)
spctl_status=$?
set -e
printf '%s\n' "$spctl_output"
if [[ $spctl_status -ne 0 ]]; then
  record_trust_failure "spctl rejected the application (exit $spctl_status)"
fi

if [[ $trust_failures -ne 0 ]]; then
  fail "$trust_failures macOS trust check(s) failed"
fi

hdiutil detach "$mount_point" >/dev/null || \
  fail "verification passed but the DMG could not be detached"
mounted=0
rmdir "$mount_point"
rmdir "$temp_root"
trap - EXIT HUP INT TERM

printf 'PASS: %s is signed, notarized, stapled, and accepted for %s distribution.\n' \
  "$dmg" "$expected_arch"
