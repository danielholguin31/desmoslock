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

for command_name in hdiutil lipo codesign; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done
[[ -x /usr/libexec/PlistBuddy ]] || fail "required command is unavailable: /usr/libexec/PlistBuddy"

dmg_dir=$(cd "$(dirname "$dmg_input")" && pwd -P)
dmg="$dmg_dir/$(basename "$dmg_input")"

printf 'Verifying DMG container: %s\n' "$dmg"
hdiutil verify "$dmg" || fail "hdiutil verification failed for $dmg"

temp_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
temp_root=$(mktemp -d "$temp_parent/desmoslock-verify.XXXXXX") || fail "could not create a temporary directory under $temp_parent"
case "$temp_root" in
  "$temp_parent"/desmoslock-verify.*) ;;
  *) fail "refusing unexpected temporary path: $temp_root" ;;
esac

mount_point="$temp_root/mount"
mkdir "$mount_point"
mounted=0

cleanup() {
  cleanup_status=$?
  trap - EXIT INT TERM

  if [[ $mounted -eq 1 ]]; then
    if ! hdiutil detach "$mount_point"; then
      printf 'ERROR: failed to detach DMG mounted at %s\n' "$mount_point" >&2
      [[ $cleanup_status -ne 0 ]] || cleanup_status=1
    fi
  fi

  if [[ -n "${entitlements_file:-}" && -f "$entitlements_file" ]]; then
    case "$entitlements_file" in
      "$temp_root"/entitlements.plist) rm -f -- "$entitlements_file" ;;
      *) printf 'ERROR: refusing unexpected entitlement cleanup path: %s\n' "$entitlements_file" >&2; cleanup_status=1 ;;
    esac
  fi

  rmdir "$mount_point" 2>/dev/null || true
  rmdir "$temp_root" 2>/dev/null || true
  exit "$cleanup_status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Mounting read-only at validated temporary path: %s\n' "$mount_point"
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount_point" "$dmg" >/dev/null || fail "could not mount $dmg read-only"
mounted=1

apps=()
while IFS= read -r -d '' app_path; do
  apps+=("$app_path")
done < <(find "$mount_point" -mindepth 1 -maxdepth 1 -type d -name '*.app' -print0)
[[ ${#apps[@]} -eq 1 ]] || fail \
  "expected exactly one top-level application in the DMG; found ${#apps[@]}"
app=${apps[0]}
[[ "$(basename "$app")" == DesmosLock.app && ! -L "$app" ]] || fail \
  "the sole top-level application must be the DesmosLock.app directory"

seen_app=0
seen_applications_link=0
seen_background=0
seen_fsevents=0
seen_ds_store=0
while IFS= read -r -d '' top_level_entry; do
  entry_name=$(basename "$top_level_entry")
  case "$entry_name" in
    DesmosLock.app)
      [[ -d "$top_level_entry" && ! -L "$top_level_entry" ]] || fail \
        "DesmosLock.app has an unexpected file type"
      seen_app=1
      ;;
    Applications)
      [[ -L "$top_level_entry" && "$(readlink "$top_level_entry")" == /Applications ]] || fail \
        "Applications must be a symbolic link to /Applications"
      seen_applications_link=1
      ;;
    .background)
      [[ -d "$top_level_entry" && ! -L "$top_level_entry" ]] || fail \
        ".background has an unexpected file type"
      seen_background=1
      ;;
    .fseventsd)
      [[ -d "$top_level_entry" && ! -L "$top_level_entry" ]] || fail \
        ".fseventsd has an unexpected file type"
      seen_fsevents=1
      ;;
    .DS_Store)
      [[ -f "$top_level_entry" && ! -L "$top_level_entry" ]] || fail \
        ".DS_Store has an unexpected file type"
      seen_ds_store=1
      ;;
    *) fail "unexpected top-level DMG entry: $entry_name" ;;
  esac
done < <(find "$mount_point" -mindepth 1 -maxdepth 1 -print0)

[[ $seen_app -eq 1 && $seen_applications_link -eq 1 && \
   $seen_background -eq 1 && $seen_fsevents -eq 1 && $seen_ds_store -eq 1 ]] || fail \
  "DMG top-level layout is missing one or more required entries"

info_plist="$app/Contents/Info.plist"
[[ -f "$info_plist" ]] || fail "application Info.plist is missing: $info_plist"
bundle_executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$info_plist" 2>/dev/null) || fail "CFBundleExecutable is missing from $info_plist"
[[ "$bundle_executable" != */* ]] || fail "CFBundleExecutable contains an unexpected path: $bundle_executable"
executable="$app/Contents/MacOS/$bundle_executable"
[[ -f "$executable" && -x "$executable" ]] || fail "application executable is missing or not executable: $executable"

actual_archs=$(lipo -archs "$executable" 2>/dev/null) || fail "could not inspect executable architecture: $executable"
actual_archs=$(printf '%s' "$actual_archs" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
[[ "$actual_archs" == "$expected_arch" ]] || fail "expected a thin $expected_arch executable, but found: $actual_archs"
printf 'Executable architecture: %s\n' "$actual_archs"

codesign --verify --deep --strict --verbose=2 "$app" || fail \
  "strict recursive code-signature verification failed for $app"

signature_info=$(codesign --display --verbose=4 "$app" 2>&1) || fail \
  "could not inspect the application signature"
printf '%s\n' "$signature_info"

printf '%s\n' "$signature_info" | grep -q '^Signature=adhoc$' || fail \
  "application does not have the required explicit ad-hoc signature"
printf '%s\n' "$signature_info" | grep -q '^CodeDirectory .*flags=.*runtime' || fail \
  "application signature does not enable the hardened-runtime flag"
if printf '%s\n' "$signature_info" | grep -q '^Authority='; then
  fail "ad-hoc signature unexpectedly contains a certificate authority"
fi

entitlements_file="$temp_root/entitlements.plist"
codesign --display --entitlements - --xml "$app" >"$entitlements_file" 2>/dev/null || fail \
  "could not extract application entitlements"
[[ -s "$entitlements_file" ]] || fail "application signature contains no entitlements"

required_entitlements=(
  com.apple.security.cs.allow-jit
  com.apple.security.cs.allow-unsigned-executable-memory
  com.apple.security.cs.disable-library-validation
)
for entitlement in "${required_entitlements[@]}"; do
  entitlement_value=$(/usr/libexec/PlistBuddy -c "Print :$entitlement" "$entitlements_file" 2>/dev/null) || fail \
    "required entitlement is missing: $entitlement"
  [[ "$entitlement_value" == true ]] || fail \
    "required entitlement is not enabled: $entitlement"
done

hdiutil detach "$mount_point" >/dev/null || fail "verification passed but the DMG could not be detached"
mounted=0
rm -f -- "$entitlements_file"
rmdir "$mount_point"
rmdir "$temp_root"
trap - EXIT INT TERM

printf 'PASS: %s has a strict ad-hoc signature, hardened runtime, required entitlements, and %s architecture.\n' \
  "$dmg" "$expected_arch"
printf 'NOTICE: this build is not Developer ID signed or notarized and must require the documented Open Anyway flow.\n'
