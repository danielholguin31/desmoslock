#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  desktop/scripts/build-macos-adhoc.sh \
    --source-sha <40-lowercase-hex-commit> \
    --source-repository <actual-owner/repository> \
    --trusted-branch <release/1.0-or-main> \
    --output-dir <new-directory>

Builds and verifies thin arm64 and x64 ad-hoc-signed DMGs from an exact clean
checkout. This build step never creates or modifies a GitHub release.
USAGE
}

source_sha=
source_repository=
trusted_branch=
output_dir=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-sha|--source-repository|--trusted-branch|--output-dir)
      [[ $# -ge 2 ]] || fail "missing value for $1"
      option=$1
      value=$2
      case "$option" in
        --source-sha) source_sha=$value ;;
        --source-repository) source_repository=$value ;;
        --trusted-branch) trusted_branch=$value ;;
        --output-dir) output_dir=$value ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
done

[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail \
  "--source-sha must be an explicit 40-character lowercase commit SHA"
[[ "$source_repository" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$ ]] || fail \
  "--source-repository must use actual owner/repository syntax"
[[ "$trusted_branch" == release/1.0 || "$trusted_branch" == main ]] || fail \
  "--trusted-branch must be release/1.0 or main"
[[ -n "$output_dir" ]] || fail "--output-dir is required"

for credential_name in \
  GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN \
  RELEASES_REPO_TOKEN RELEASES_REPO_READ_TOKEN \
  CSC_LINK CSC_NAME CSC_IDENTITY CSC_IDENTITY_AUTO_DISCOVERY \
  CSC_KEY_PASSWORD CSC_KEYCHAIN CSC_FOR_PULL_REQUEST \
  CSC_INSTALLER_LINK CSC_INSTALLER_KEY_PASSWORD \
  WIN_CSC_LINK WIN_CSC_KEY_PASSWORD \
  APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID \
  APPLE_API_KEY APPLE_API_KEY_PATH APPLE_API_KEY_B64 \
  APPLE_API_KEY_ID APPLE_API_ISSUER \
  APPLE_KEYCHAIN APPLE_KEYCHAIN_PROFILE; do
  if printenv "$credential_name" >/dev/null 2>&1; then
    fail "$credential_name must not be present during the credential-free ad-hoc build"
  fi
done

for command_name in \
  git node npm shasum mktemp sw_vers uname xcode-select xcrun clang codesign pkgutil; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done

script_dir=$(cd "$(dirname "$0")" && pwd -P)
repo_root=$(git -C "$script_dir/../.." rev-parse --show-toplevel 2>/dev/null) || fail \
  "builder is not inside a Git checkout"
current_head=$(git -C "$repo_root" rev-parse HEAD)
[[ "$current_head" == "$source_sha" ]] || fail \
  "current checkout is $current_head, not requested source $source_sha"
origin_url=$(git -C "$repo_root" remote get-url origin) || fail "origin remote is missing"
origin_repository=$(node - "$script_dir/provenance-contract.js" "$origin_url" <<'NODE'
const contract = require(process.argv[2]);
process.stdout.write(contract.parseGitHubRepositoryRemote(process.argv[3]));
NODE
) || fail "origin is not an uncredentialed GitHub repository URL"
[[ "$origin_repository" == "$source_repository" ]] || fail \
  "origin repository is $origin_repository, not requested source $source_repository"
git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$trusted_branch" || fail \
  "fetched origin/$trusted_branch is missing"
branch_sha=$(git -C "$repo_root" rev-parse "refs/remotes/origin/$trusted_branch^{commit}")
[[ "$branch_sha" == "$source_sha" ]] || fail \
  "requested source is not the fetched origin/$trusted_branch HEAD"
git -C "$repo_root" merge-base --is-ancestor \
  "$source_sha" "refs/remotes/origin/$trusted_branch" || fail \
  "requested source is not contained in origin/$trusted_branch"

require_exact_source_state() {
  source_changes=$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)
  [[ -z "$source_changes" ]] || fail \
    "tracked, staged, or untracked files would make the build differ from $source_sha"

  ignored_package_inputs=$(git -C "$repo_root" ls-files \
    --others --ignored --exclude-standard -- \
    desktop/main.js desktop/preload.js desktop/renderer)
  [[ -z "$ignored_package_inputs" ]] || fail \
    "ignored files are present inside Electron's explicit source inputs"
}

require_exact_source_state

node - "$repo_root/desktop/package.json" <<'NODE'
const config = require(process.argv[2]).build.mac;
if (config.identity !== '-') throw new Error('mac.identity must explicitly select ad-hoc signing');
if (config.sign !== './scripts/sign-macos-adhoc.js') throw new Error('ad-hoc signing hook changed');
if (config.notarize !== false) throw new Error('mac.notarize must be disabled');
if (config.forceCodeSigning !== true) throw new Error('mac.forceCodeSigning must remain enabled');
if (config.hardenedRuntime !== true) throw new Error('mac.hardenedRuntime must remain enabled');
if (config.entitlements !== 'build/entitlements.mac.plist') throw new Error('main entitlements path changed');
if (config.entitlementsInherit !== 'build/entitlements.mac.inherit.plist') throw new Error('inherited entitlements path changed');
NODE

desktop_version=$(node -p "require('$repo_root/desktop/package.json').version")
[[ "$desktop_version" == 1.0.1 ]] || fail \
  "this recovery builder requires desktop version 1.0.1; found $desktop_version"
node_major=$(node --version | sed -E 's/^v([0-9]+).*/\1/')
[[ "$node_major" == 22 ]] || fail "Node 22 is required; found $(node --version)"
npm_major=$(npm --version | awk -F. '{print $1}')
[[ "$npm_major" == 10 ]] || fail "npm 10 is required; found npm $(npm --version)"

output_parent=$(cd "$(dirname "$output_dir")" && pwd -P) || fail \
  "output parent does not exist: $(dirname "$output_dir")"
output_name=$(basename "$output_dir")
[[ "$output_name" != . && "$output_name" != .. && -n "$output_name" ]] || fail \
  "output directory must name a new child directory"
output_dir="$output_parent/$output_name"
[[ ! -e "$output_dir" ]] || fail "output path already exists: $output_dir"

temp_root=$(mktemp -d "$output_parent/.desmoslock-macos-build.XXXXXX") || fail \
  "could not create a temporary build directory under $output_parent"
case "$temp_root" in
  "$output_parent"/.desmoslock-macos-build.*) ;;
  *) fail "refusing unexpected temporary path: $temp_root" ;;
esac

cleanup() {
  cleanup_status=$?
  trap - EXIT INT TERM
  case "$temp_root" in
    "$output_parent"/.desmoslock-macos-build.*) rm -rf -- "$temp_root" ;;
    *) printf 'ERROR: refusing unexpected cleanup path: %s\n' "$temp_root" >&2; cleanup_status=1 ;;
  esac
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

build_dir="$temp_root/build"
staging_dir="$temp_root/output"
mkdir "$build_dir" "$staging_dir"

printf 'Installing locked dependencies and rebuilding the committed vendor bundle...\n'
npm --prefix "$repo_root/desktop" ci
npm --prefix "$repo_root/desktop" run build:vendor
require_exact_source_state

printf 'Building ad-hoc-signed arm64 and x64 DMGs from %s...\n' "$source_sha"
(
  cd "$repo_root/desktop"
  CSC_IDENTITY_AUTO_DISCOVERY=false \
    ./node_modules/.bin/electron-builder --mac --publish never \
      --config.directories.output="$build_dir"
)

find_one() {
  search_root=$1
  pattern=$2
  description=$3
  matches=()
  while IFS= read -r -d '' match; do
    matches+=("$match")
  done < <(find "$search_root" -type f -name "$pattern" -print0)
  [[ ${#matches[@]} -eq 1 ]] || fail \
    "expected exactly one $description in $search_root; found ${#matches[@]}"
  printf '%s\n' "${matches[0]}"
}

mac_arm64=$(find_one "$build_dir" '*arm64*.dmg' 'arm64 DMG')
mac_x64=$(find_one "$build_dir" '*x64*.dmg' 'x64 DMG')
"$script_dir/verify-macos-dmg.sh" "$mac_arm64" arm64
"$script_dir/verify-macos-dmg.sh" "$mac_x64" x86_64

cp -- "$mac_arm64" "$staging_dir/$(basename "$mac_arm64")"
cp -- "$mac_x64" "$staging_dir/$(basename "$mac_x64")"
arm64_name=$(basename "$mac_arm64")
x64_name=$(basename "$mac_x64")
arm64_sha=$(shasum -a 256 "$staging_dir/$arm64_name" | awk '{print $1}')
x64_sha=$(shasum -a 256 "$staging_dir/$x64_name" | awk '{print $1}')
arm64_bytes=$(wc -c < "$staging_dir/$arm64_name" | tr -d ' ')
x64_bytes=$(wc -c < "$staging_dir/$x64_name" | tr -d ' ')
built_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
node_version=$(node --version)
npm_version=$(npm --version)
builder_version=$("$repo_root/desktop/node_modules/.bin/electron-builder" --version)
locked_builder_version=$(node -p \
  "require('$repo_root/desktop/package-lock.json').packages['node_modules/electron-builder'].version")
[[ "$builder_version" == "$locked_builder_version" ]] || fail \
  "electron-builder $builder_version does not match locked $locked_builder_version"
macos_product_version=$(sw_vers -productVersion)
macos_build_version=$(sw_vers -buildVersion)
builder_architecture=$(uname -m)
selected_developer_dir=$(xcode-select -p)
macos_sdk_version=$(xcrun --sdk macosx --show-sdk-version)
apple_clang_version=$(xcrun clang --version | sed -n '1p')
codesign_path=$(xcrun --find codesign)

case "$selected_developer_dir" in
  /Library/Developer/CommandLineTools)
    developer_tools_kind=command-line-tools
    developer_tools_version=$(pkgutil --pkg-info com.apple.pkg.CLTools_Executables |
      awk '$1 == "version:" { print $2 }')
    ;;
  /*.app/Contents/Developer)
    developer_tools_kind=xcode
    developer_tools_version=$(DEVELOPER_DIR="$selected_developer_dir" xcodebuild -version |
      awk 'NR == 1 && $1 == "Xcode" { print $2 }')
    ;;
  *)
    fail "unsupported selected developer directory: $selected_developer_dir"
    ;;
esac
[[ -n "$developer_tools_version" ]] || fail "could not determine Xcode/CLT version"

node - "$staging_dir/MACOS-BUILD-METADATA.json" \
  "$script_dir/provenance-contract.js" \
  "$source_repository" "$source_sha" "$trusted_branch" "$built_at" \
  "$arm64_name" "$arm64_sha" "$arm64_bytes" \
  "$x64_name" "$x64_sha" "$x64_bytes" \
  "$node_version" "$npm_version" "$builder_version" \
  "$macos_product_version" "$macos_build_version" "$builder_architecture" \
  "$developer_tools_kind" "$developer_tools_version" "$selected_developer_dir" \
  "$macos_sdk_version" "$apple_clang_version" "$codesign_path" <<'NODE'
const fs = require('fs');
const [
  output, contractPath, sourceRepository, sourceSha, trustedBranch, builtAtUtc,
  arm64FileName, arm64Sha256, arm64Bytes,
  x64FileName, x64Sha256, x64Bytes,
  nodeVersion, npmVersion, electronBuilderVersion,
  macosProductVersion, macosBuildVersion, builderArchitecture,
  developerToolsKind, developerToolsVersion, selectedDeveloperDirectory,
  macosSdkVersion, appleClangVersion, codesignPath,
] = process.argv.slice(2);
const { validateMacBuildMetadataCore } = require(contractPath);
const metadata = {
  schemaVersion: 1,
  sourceRepository,
  sourceSha,
  trustedBranch,
  version: '1.0.1',
  platform: 'macos',
  targetArchitecture: 'arm64+x64',
  signing: 'ad-hoc',
  notarized: false,
  hardenedRuntime: true,
  builtAtUtc,
  nodeVersion,
  npmVersion,
  electronBuilderVersion,
  builder: {
    os: {
      name: 'macOS',
      productVersion: macosProductVersion,
      buildVersion: macosBuildVersion,
    },
    architecture: builderArchitecture,
    developerTools: {
      kind: developerToolsKind,
      version: developerToolsVersion,
      selectedDirectory: selectedDeveloperDirectory,
      macosSdkVersion,
      appleClangVersion,
      codesignPath,
    },
  },
  assets: {
    arm64: { fileName: arm64FileName, bytes: Number(arm64Bytes), sha256: arm64Sha256 },
    x86_64: { fileName: x64FileName, bytes: Number(x64Bytes), sha256: x64Sha256 },
  },
};
validateMacBuildMetadataCore(metadata, {
  sourceRepository,
  sourceSha,
  trustedBranch,
  electronBuilderVersion,
});
fs.writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
NODE

file_count=$(find "$staging_dir" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')
[[ "$file_count" -eq 3 ]] || fail "expected two DMGs and one metadata file; found $file_count files"
mv -- "$staging_dir" "$output_dir"

trap - EXIT INT TERM
case "$temp_root" in
  "$output_parent"/.desmoslock-macos-build.*) rm -rf -- "$temp_root" ;;
  *) fail "refusing unexpected cleanup path: $temp_root" ;;
esac

printf 'PASS: built and verified exact-source macOS inputs in %s\n' "$output_dir"
printf 'No release was created or modified.\n'
