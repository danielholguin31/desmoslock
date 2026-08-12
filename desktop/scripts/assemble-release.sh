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
  desktop/scripts/assemble-release.sh \
    --source-sha <40-lowercase-hex-commit> \
    --canonical-source-repository <owner/repository> \
    --workflow-repository <actual-actions-owner/repository> \
    --trusted-branch <release/1.0-or-main> \
    --mac-arm64-dmg <path> \
    --mac-x64-dmg <path> \
    --mac-build-metadata <path> \
    --windows-run-id <actions-run-id> \
    --windows-artifact-id <actions-artifact-id> \
    --windows-run-json <path> \
    --windows-artifact-json <path> \
    --windows-artifact-zip <path> \
    --linux-run-id <actions-run-id> \
    --linux-artifact-id <actions-artifact-id> \
    --linux-run-json <path> \
    --linux-artifact-json <path> \
    --linux-artifact-zip <path> \
    --output-dir <new-directory>

Validates already-fetched build evidence entirely offline and creates exactly six
stable release files. It invokes no GitHub or network client and never creates or
modifies a release.
USAGE
}

source_sha=
canonical_source_repository=
workflow_repository=
trusted_branch=
mac_arm64_dmg=
mac_x64_dmg=
mac_build_metadata=
windows_run_id=
windows_artifact_id=
windows_run_json=
windows_artifact_json=
windows_artifact_zip=
linux_run_id=
linux_artifact_id=
linux_run_json=
linux_artifact_json=
linux_artifact_zip=
output_dir=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-sha|--canonical-source-repository|--workflow-repository|--trusted-branch|--mac-arm64-dmg|--mac-x64-dmg|--mac-build-metadata|--windows-run-id|--windows-artifact-id|--windows-run-json|--windows-artifact-json|--windows-artifact-zip|--linux-run-id|--linux-artifact-id|--linux-run-json|--linux-artifact-json|--linux-artifact-zip|--output-dir)
      [[ $# -ge 2 ]] || fail "missing value for $1"
      option=$1
      value=$2
      case "$option" in
        --source-sha) source_sha=$value ;;
        --canonical-source-repository) canonical_source_repository=$value ;;
        --workflow-repository) workflow_repository=$value ;;
        --trusted-branch) trusted_branch=$value ;;
        --mac-arm64-dmg) mac_arm64_dmg=$value ;;
        --mac-x64-dmg) mac_x64_dmg=$value ;;
        --mac-build-metadata) mac_build_metadata=$value ;;
        --windows-run-id) windows_run_id=$value ;;
        --windows-artifact-id) windows_artifact_id=$value ;;
        --windows-run-json) windows_run_json=$value ;;
        --windows-artifact-json) windows_artifact_json=$value ;;
        --windows-artifact-zip) windows_artifact_zip=$value ;;
        --linux-run-id) linux_run_id=$value ;;
        --linux-artifact-id) linux_artifact_id=$value ;;
        --linux-run-json) linux_run_json=$value ;;
        --linux-artifact-json) linux_artifact_json=$value ;;
        --linux-artifact-zip) linux_artifact_zip=$value ;;
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
[[ "$canonical_source_repository" == desmoslock/desmoslock ]] || fail \
  "--canonical-source-repository must be desmoslock/desmoslock"
[[ "$workflow_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail \
  "--workflow-repository must use owner/repository syntax"
[[ "$trusted_branch" == release/1.0 || "$trusted_branch" == main ]] || fail \
  "--trusted-branch must be release/1.0 or main"
[[ "$windows_run_id" =~ ^[1-9][0-9]*$ ]] || fail \
  "--windows-run-id must be a positive integer"
[[ "$windows_artifact_id" =~ ^[1-9][0-9]*$ ]] || fail \
  "--windows-artifact-id must be a positive integer"
[[ "$linux_run_id" =~ ^[1-9][0-9]*$ ]] || fail \
  "--linux-run-id must be a positive integer"
[[ "$linux_artifact_id" =~ ^[1-9][0-9]*$ ]] || fail \
  "--linux-artifact-id must be a positive integer"
[[ -n "$output_dir" ]] || fail "--output-dir is required"

[[ -z "${GH_TOKEN:-}" ]] || fail "GH_TOKEN must not be present during offline assembly"
[[ -z "${GITHUB_TOKEN:-}" ]] || fail "GITHUB_TOKEN must not be present during offline assembly"
[[ -z "${GH_ENTERPRISE_TOKEN:-}" ]] || fail \
  "GH_ENTERPRISE_TOKEN must not be present during offline assembly"
[[ -z "${GITHUB_ENTERPRISE_TOKEN:-}" ]] || fail \
  "GITHUB_ENTERPRISE_TOKEN must not be present during offline assembly"
[[ -z "${RELEASES_REPO_TOKEN:-}" ]] || fail \
  "RELEASES_REPO_TOKEN must not be present during offline assembly"
[[ -z "${RELEASES_REPO_READ_TOKEN:-}" ]] || fail \
  "RELEASES_REPO_READ_TOKEN must not be present during offline assembly"

for command_name in git node unzip shasum file mktemp chmod; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done

for input_file in \
  "$mac_arm64_dmg" "$mac_x64_dmg" "$mac_build_metadata" \
  "$windows_run_json" "$windows_artifact_json" "$windows_artifact_zip" \
  "$linux_run_json" "$linux_artifact_json" "$linux_artifact_zip"; do
  [[ -f "$input_file" && -r "$input_file" ]] || fail \
    "required evidence file is missing or unreadable: $input_file"
done

script_dir=$(cd "$(dirname "$0")" && pwd -P)
repo_root=$(git -C "$script_dir/../.." rev-parse --show-toplevel 2>/dev/null) || fail \
  "assembler is not inside a Git checkout"
seven_zip=$(node - "$repo_root/desktop" <<'NODE'
const path = require('path');
const desktopRoot = process.argv[2];
const modulePath = require.resolve('7zip-bin', { paths: [desktopRoot] });
const binary = require(modulePath).path7za;
if (typeof binary !== 'string' || !path.isAbsolute(binary)) process.exit(1);
process.stdout.write(binary);
NODE
) || fail "locked 7zip-bin dependency is unavailable; run npm 10 ci before going offline"
case "$seven_zip" in
  "$repo_root"/desktop/node_modules/7zip-bin/*) ;;
  *) fail "resolved 7zip-bin path escaped the locked package: $seven_zip" ;;
esac
[[ -f "$seven_zip" && ! -L "$seven_zip" ]] || fail \
  "locked 7zip-bin path must be a regular, non-symlink file: $seven_zip"
chmod 0755 "$seven_zip" || fail "could not enable the packaged 7zip-bin executable"
[[ -x "$seven_zip" ]] || fail "locked 7zip-bin executable is unavailable: $seven_zip"
current_head=$(git -C "$repo_root" rev-parse HEAD)
[[ "$current_head" == "$source_sha" ]] || fail \
  "current checkout is $current_head, not requested source $source_sha"
source_changes=$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)
[[ -z "$source_changes" ]] || fail \
  "tracked, staged, or untracked files prevent exact-source assembly"
ignored_package_inputs=$(git -C "$repo_root" ls-files \
  --others --ignored --exclude-standard -- \
  desktop/main.js desktop/preload.js desktop/renderer)
[[ -z "$ignored_package_inputs" ]] || fail \
  "ignored files are present inside Electron's explicit source inputs"

desktop_version=$(node -p "require('$repo_root/desktop/package.json').version")
[[ "$desktop_version" == 1.0.1 ]] || fail \
  "this recovery assembler requires desktop version 1.0.1; found $desktop_version"

output_parent=$(cd "$(dirname "$output_dir")" && pwd -P) || fail \
  "output parent does not exist: $(dirname "$output_dir")"
output_name=$(basename "$output_dir")
[[ "$output_name" != . && "$output_name" != .. && -n "$output_name" ]] || fail \
  "output directory must name a new child directory"
output_dir="$output_parent/$output_name"
[[ ! -e "$output_dir" ]] || fail "output path already exists: $output_dir"

temp_root=$(mktemp -d "$output_parent/.desmoslock-assemble.XXXXXX") || fail \
  "could not create a temporary assembly directory under $output_parent"
case "$temp_root" in
  "$output_parent"/.desmoslock-assemble.*) ;;
  *) fail "refusing unexpected temporary path: $temp_root" ;;
esac

cleanup() {
  cleanup_status=$?
  trap - EXIT INT TERM
  case "$temp_root" in
    "$output_parent"/.desmoslock-assemble.*) rm -rf -- "$temp_root" ;;
    *) printf 'ERROR: refusing unexpected cleanup path: %s\n' "$temp_root" >&2; cleanup_status=1 ;;
  esac
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

downloads_dir="$temp_root/downloads"
staging_dir="$temp_root/release"
mkdir "$downloads_dir" "$staging_dir"

validate_run() {
  platform=$1
  run_id=$2
  run_file=$3
  node - "$run_file" "$run_id" "$source_sha" "$workflow_repository" "$trusted_branch" <<'NODE'
const fs = require('fs');
const [file, expectedRunId, expectedSha, expectedRepository, expectedBranch] = process.argv.slice(2);
const run = JSON.parse(fs.readFileSync(file, 'utf8'));
const failures = [];
if (String(run.id) !== expectedRunId) failures.push(`run id is ${run.id}`);
if (run.head_sha !== expectedSha) failures.push(`run head is ${run.head_sha}`);
if (!run.repository || run.repository.full_name !== expectedRepository) {
  failures.push(`repository is ${run.repository && run.repository.full_name}`);
}
if (run.head_branch !== expectedBranch) failures.push(`head branch is ${run.head_branch}`);
if (run.event !== 'workflow_dispatch') failures.push(`event is ${run.event}`);
if (run.status !== 'completed') failures.push(`status is ${run.status}`);
if (run.conclusion !== 'success') failures.push(`conclusion is ${run.conclusion}`);
if (run.path !== '.github/workflows/release.yml') failures.push(`workflow path is ${run.path}`);
if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
  failures.push(`run attempt is ${run.run_attempt}`);
}
if (failures.length) {
  console.error(`ERROR: ${expectedRunId} did not satisfy run provenance checks: ${failures.join('; ')}`);
  process.exit(1);
}
process.stdout.write(String(run.run_attempt));
NODE
}

validate_and_extract_artifact() {
  platform=$1
  run_id=$2
  artifact_id=$3
  run_attempt=$4
  artifact_file=$5
  archive_file=$6
  run_file=$7
  expected_name="installer-$platform-$source_sha"
  extraction_dir="$downloads_dir/$platform"

  node - "$artifact_file" "$archive_file" "$run_file" "$artifact_id" "$run_id" "$source_sha" "$expected_name" "$trusted_branch" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const [file, archiveFile, runFile, expectedArtifactId, expectedRunId, expectedSha, expectedName, expectedBranch] = process.argv.slice(2);
const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
const failures = [];
if (String(artifact.id) !== expectedArtifactId) failures.push(`artifact id is ${artifact.id}`);
if (artifact.name !== expectedName) failures.push(`name is ${artifact.name}`);
if (artifact.expired !== false) failures.push('artifact is expired');
if (!(Number(artifact.size_in_bytes) > 0)) failures.push('artifact is empty');
if (Number(artifact.size_in_bytes) !== fs.statSync(archiveFile).size) {
  failures.push(`ZIP byte length is ${fs.statSync(archiveFile).size}, expected ${artifact.size_in_bytes}`);
}
const archiveDigest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(archiveFile)).digest('hex')}`;
if (artifact.digest !== archiveDigest) {
  failures.push(`artifact digest is ${artifact.digest}, actual ${archiveDigest}`);
}
if (!artifact.workflow_run || String(artifact.workflow_run.id) !== expectedRunId) {
  failures.push(`workflow run is ${artifact.workflow_run && artifact.workflow_run.id}`);
}
if (!artifact.workflow_run || artifact.workflow_run.head_sha !== expectedSha) {
  failures.push(`artifact head is ${artifact.workflow_run && artifact.workflow_run.head_sha}`);
}
if (artifact.workflow_run && artifact.workflow_run.head_branch != null &&
    artifact.workflow_run.head_branch !== expectedBranch) {
  failures.push(`artifact head branch is ${artifact.workflow_run.head_branch}`);
}
if (artifact.workflow_run && artifact.workflow_run.repository_id != null &&
    String(artifact.workflow_run.repository_id) !== String(run.repository && run.repository.id)) {
  failures.push(`artifact repository id is ${artifact.workflow_run.repository_id}`);
}
if (artifact.workflow_run && artifact.workflow_run.head_repository_id != null &&
    String(artifact.workflow_run.head_repository_id) !== String(run.head_repository && run.head_repository.id)) {
  failures.push(`artifact head repository id is ${artifact.workflow_run.head_repository_id}`);
}
if (failures.length) {
  console.error(`ERROR: ${expectedArtifactId} did not satisfy artifact provenance checks: ${failures.join('; ')}`);
  process.exit(1);
}
NODE

  unzip -tq "$archive_file" >/dev/null || fail "$platform artifact ZIP is invalid"
  unzip -Z1 "$archive_file" | while IFS= read -r entry; do
    case "$entry" in
      /*|../*|*/../*|*/..) fail "unsafe archive path in $platform artifact: $entry" ;;
    esac
  done
  mkdir "$extraction_dir"
  unzip -q "$archive_file" -d "$extraction_dir"

  [[ -z "$(find "$extraction_dir" -type l -print -quit)" ]] || fail \
    "$platform artifact must not contain symbolic links"

  node - "$extraction_dir/BUILD-METADATA.json" "$source_sha" \
    "$canonical_source_repository" "$workflow_repository" \
    "$platform" "$run_id" "$run_attempt" <<'NODE'
const fs = require('fs');
const [
  file, expectedSha, expectedCanonicalRepository, expectedWorkflowRepository,
  expectedPlatform, expectedRunId, expectedRunAttempt,
] = process.argv.slice(2);
if (!fs.existsSync(file)) {
  console.error(`ERROR: build metadata is missing: ${file}`);
  process.exit(1);
}
const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
const failures = [];
if (metadata.schemaVersion !== 1) failures.push(`schema is ${metadata.schemaVersion}`);
if (metadata.sourceSha !== expectedSha) failures.push(`source is ${metadata.sourceSha}`);
if (metadata.canonicalSourceRepository !== expectedCanonicalRepository) {
  failures.push(`canonical repository is ${metadata.canonicalSourceRepository}`);
}
if (metadata.workflowRepository !== expectedWorkflowRepository) {
  failures.push(`workflow repository is ${metadata.workflowRepository}`);
}
if (metadata.platform !== expectedPlatform) failures.push(`platform is ${metadata.platform}`);
if (metadata.targetArchitecture !== 'x64') failures.push(`target architecture is ${metadata.targetArchitecture}`);
if (String(metadata.workflowRunId) !== expectedRunId) failures.push(`run id is ${metadata.workflowRunId}`);
if (String(metadata.workflowRunAttempt) !== expectedRunAttempt) failures.push(`run attempt is ${metadata.workflowRunAttempt}`);
if (metadata.version !== '1.0.1') failures.push(`version is ${metadata.version}`);
if (failures.length) {
  console.error(`ERROR: embedded build metadata did not satisfy provenance checks: ${failures.join('; ')}`);
  process.exit(1);
}
NODE

  extracted_count=$(find "$extraction_dir" -type f | wc -l | tr -d ' ')
  extracted_dir_count=$(find "$extraction_dir" -mindepth 1 -type d | wc -l | tr -d ' ')
  if [[ "$platform" == windows ]]; then
    [[ -f "$extraction_dir/win-unpacked/DesmosLock.exe" ]] || fail \
      "Windows artifact is missing the independently verifiable x64 application payload"
    [[ -f "$extraction_dir/win-unpacked/resources/app.asar" ]] || fail \
      "Windows artifact is missing win-unpacked/resources/app.asar"
    [[ "$extracted_count" -eq 4 && "$extracted_dir_count" -eq 2 ]] || fail \
      "expected installer, metadata, payload, and app.asar in Windows artifact"
  else
    [[ "$extracted_count" -eq 2 && "$extracted_dir_count" -eq 0 ]] || fail \
      "expected only installer and BUILD-METADATA.json in Linux artifact"
  fi
}

windows_run_attempt=$(validate_run windows "$windows_run_id" "$windows_run_json")
linux_run_attempt=$(validate_run linux "$linux_run_id" "$linux_run_json")
validate_and_extract_artifact windows "$windows_run_id" "$windows_artifact_id" \
  "$windows_run_attempt" "$windows_artifact_json" "$windows_artifact_zip" "$windows_run_json"
validate_and_extract_artifact linux "$linux_run_id" "$linux_artifact_id" \
  "$linux_run_attempt" "$linux_artifact_json" "$linux_artifact_zip" "$linux_run_json"

find_one() {
  search_root=$1
  pattern=$2
  description=$3
  matches=()
  while IFS= read -r -d '' match; do
    matches+=("$match")
  done < <(find "$search_root" -mindepth 1 -maxdepth 1 -type f -name "$pattern" -print0)
  [[ ${#matches[@]} -eq 1 ]] || fail \
    "expected exactly one $description in $search_root; found ${#matches[@]}"
  printf '%s\n' "${matches[0]}"
}

windows_installer=$(find_one "$downloads_dir/windows" '*.exe' 'Windows installer')
windows_payload="$downloads_dir/windows/win-unpacked/DesmosLock.exe"
windows_application_archive="$downloads_dir/windows/win-unpacked/resources/app.asar"
linux_installer=$(find_one "$downloads_dir/linux" '*.AppImage' 'Linux AppImage')
file "$windows_installer" | grep -Eq 'PE32 executable.*Nullsoft Installer' || fail \
  "Windows installer is not the expected PE32 NSIS wrapper"
file "$linux_installer" | grep -Eq 'ELF 64-bit.*x86-64' || fail \
  "Linux installer is not an x86-64 ELF executable"

embedded_windows_payload="$temp_root/installer-DesmosLock.exe"
embedded_application_archive="$temp_root/installer-app.asar"
"$seven_zip" t "$windows_installer" >/dev/null || fail \
  "Windows installer failed the locked 7-Zip archive test"
"$seven_zip" x -so "$windows_installer" DesmosLock.exe > "$embedded_windows_payload" || fail \
  "could not extract the application executable from the Windows installer"
"$seven_zip" x -so "$windows_installer" resources/app.asar > "$embedded_application_archive" || fail \
  "could not extract resources/app.asar from the Windows installer"
[[ -s "$embedded_windows_payload" && -s "$embedded_application_archive" ]] || fail \
  "Windows installer extraction produced an empty required file"

node - \
  "$downloads_dir/windows/BUILD-METADATA.json" \
  "$windows_installer" "$windows_payload" "$windows_application_archive" \
  "$embedded_windows_payload" "$embedded_application_archive" windows \
  "$downloads_dir/linux/BUILD-METADATA.json" "$linux_installer" linux <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const [
  windowsMetadataFile, windowsInstaller, windowsPayload, windowsApplicationArchive,
  embeddedWindowsPayload, embeddedApplicationArchive, windowsPlatform,
  linuxMetadataFile, linuxInstaller, linuxPlatform,
] = process.argv.slice(2);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function peMachine(file) {
  const data = fs.readFileSync(file);
  if (data.toString('ascii', 0, 2) !== 'MZ') throw new Error(`missing MZ header: ${file}`);
  const offset = data.readUInt32LE(0x3c);
  if (!data.subarray(offset, offset + 4).equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))) {
    throw new Error(`missing PE signature: ${file}`);
  }
  return `0x${data.readUInt16LE(offset + 4).toString(16).padStart(4, '0')}`;
}

function validate(metadataFile, installer, platform, windowsEvidence = null) {
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  const actual = {
    fileName: path.basename(installer),
    bytes: fs.statSync(installer).size,
    sha256: sha256(installer),
  };
  const failures = [];
  if (!metadata.artifact) failures.push('artifact metadata is missing');
  if (metadata.artifact && metadata.artifact.fileName !== actual.fileName) failures.push(`file name is ${metadata.artifact.fileName}`);
  if (metadata.artifact && metadata.artifact.bytes !== actual.bytes) failures.push(`byte length is ${metadata.artifact.bytes}, actual ${actual.bytes}`);
  if (metadata.artifact && metadata.artifact.sha256 !== actual.sha256) failures.push('installer SHA-256 does not match metadata');
  if (metadata.artifact && metadata.artifact.targetArchitecture !== 'x64') failures.push(`installer target architecture is ${metadata.artifact.targetArchitecture}`);
  if (platform === 'windows') {
    const {
      payload, applicationArchive, embeddedPayload, embeddedArchive,
    } = windowsEvidence;
    const wrapperMachine = peMachine(installer);
    const payloadMachine = peMachine(payload);
    const embeddedPayloadMachine = peMachine(embeddedPayload);
    const actualPayload = {
      fileName: path.basename(payload),
      bytes: fs.statSync(payload).size,
      sha256: sha256(payload),
    };
    const actualApplicationArchive = {
      fileName: path.basename(applicationArchive),
      bytes: fs.statSync(applicationArchive).size,
      sha256: sha256(applicationArchive),
    };
    if (wrapperMachine !== '0x014c') failures.push(`actual wrapper machine is ${wrapperMachine}`);
    if (payloadMachine !== '0x8664') failures.push(`actual payload machine is ${payloadMachine}`);
    if (embeddedPayloadMachine !== '0x8664') failures.push(`embedded payload machine is ${embeddedPayloadMachine}`);
    if (metadata.wrapperMachine !== '0x014c') failures.push(`recorded wrapper machine is ${metadata.wrapperMachine}`);
    if (metadata.payloadMachine !== '0x8664') failures.push(`recorded payload machine is ${metadata.payloadMachine}`);
    if (metadata.targetArchitecture !== 'x64') failures.push(`target architecture is ${metadata.targetArchitecture}`);
    if (!metadata.payload) failures.push('payload metadata is missing');
    if (metadata.payload && metadata.payload.fileName !== actualPayload.fileName) failures.push(`payload file name is ${metadata.payload.fileName}`);
    if (metadata.payload && metadata.payload.targetArchitecture !== 'x64') failures.push(`payload target architecture is ${metadata.payload.targetArchitecture}`);
    if (metadata.payload && metadata.payload.bytes !== actualPayload.bytes) failures.push(`payload byte length is ${metadata.payload.bytes}, actual ${actualPayload.bytes}`);
    if (metadata.payload && metadata.payload.sha256 !== actualPayload.sha256) failures.push('payload SHA-256 does not match metadata');
    if (!metadata.applicationArchive) failures.push('application archive metadata is missing');
    if (metadata.applicationArchive && metadata.applicationArchive.fileName !== actualApplicationArchive.fileName) failures.push(`application archive file name is ${metadata.applicationArchive.fileName}`);
    if (metadata.applicationArchive && metadata.applicationArchive.targetArchitecture !== 'platform-neutral') failures.push(`application archive target is ${metadata.applicationArchive.targetArchitecture}`);
    if (metadata.applicationArchive && metadata.applicationArchive.bytes !== actualApplicationArchive.bytes) failures.push(`application archive byte length is ${metadata.applicationArchive.bytes}, actual ${actualApplicationArchive.bytes}`);
    if (metadata.applicationArchive && metadata.applicationArchive.sha256 !== actualApplicationArchive.sha256) failures.push('application archive SHA-256 does not match metadata');
    if (fs.statSync(embeddedArchive).size !== actualApplicationArchive.bytes ||
        sha256(embeddedArchive) !== actualApplicationArchive.sha256) {
      failures.push('installer resources/app.asar differs from win-unpacked/resources/app.asar');
    }
  }
  if (failures.length) throw new Error(`${platform} installer integrity failed: ${failures.join('; ')}`);
}

validate(windowsMetadataFile, windowsInstaller, windowsPlatform, {
  payload: windowsPayload,
  applicationArchive: windowsApplicationArchive,
  embeddedPayload: embeddedWindowsPayload,
  embeddedArchive: embeddedApplicationArchive,
});
validate(linuxMetadataFile, linuxInstaller, linuxPlatform);
NODE

"$script_dir/verify-macos-dmg.sh" "$mac_arm64_dmg" arm64
"$script_dir/verify-macos-dmg.sh" "$mac_x64_dmg" x86_64
node - "$mac_build_metadata" "$mac_arm64_dmg" "$mac_x64_dmg" \
  "$source_sha" "$canonical_source_repository" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const [metadataFile, arm64Dmg, x64Dmg, expectedSha, expectedRepository] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
const failures = [];
const releaseVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const nodeVersion = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function validateAsset(key, file) {
  const expected = metadata.assets && metadata.assets[key];
  const actualSha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const actualBytes = fs.statSync(file).size;
  if (!expected) failures.push(`${key} metadata is missing`);
  if (expected && expected.fileName !== path.basename(file)) failures.push(`${key} file name is ${expected.fileName}`);
  if (expected && expected.bytes !== actualBytes) failures.push(`${key} byte length is ${expected.bytes}, actual ${actualBytes}`);
  if (expected && expected.sha256 !== actualSha) failures.push(`${key} SHA-256 does not match metadata`);
}
if (metadata.schemaVersion !== 1) failures.push(`schema is ${metadata.schemaVersion}`);
if (metadata.sourceSha !== expectedSha) failures.push(`source is ${metadata.sourceSha}`);
if (metadata.canonicalSourceRepository !== expectedRepository) {
  failures.push(`canonical repository is ${metadata.canonicalSourceRepository}`);
}
if (metadata.version !== '1.0.1') failures.push(`version is ${metadata.version}`);
if (metadata.platform !== 'macos') failures.push(`platform is ${metadata.platform}`);
if (metadata.targetArchitecture !== 'arm64+x64') failures.push(`target architecture is ${metadata.targetArchitecture}`);
if (metadata.signing !== 'ad-hoc') failures.push(`signing is ${metadata.signing}`);
if (metadata.notarized !== false) failures.push(`notarized is ${metadata.notarized}`);
if (metadata.hardenedRuntime !== true) failures.push(`hardenedRuntime is ${metadata.hardenedRuntime}`);
if (typeof metadata.builtAtUtc !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(metadata.builtAtUtc) ||
    !Number.isFinite(Date.parse(metadata.builtAtUtc))) {
  failures.push(`builtAtUtc is ${metadata.builtAtUtc}`);
}
if (typeof metadata.nodeVersion !== 'string' || !nodeVersion.test(metadata.nodeVersion)) {
  failures.push(`nodeVersion is ${metadata.nodeVersion}`);
}
if (typeof metadata.npmVersion !== 'string' || !releaseVersion.test(metadata.npmVersion)) {
  failures.push(`npmVersion is ${metadata.npmVersion}`);
}
if (typeof metadata.electronBuilderVersion !== 'string' ||
    !releaseVersion.test(metadata.electronBuilderVersion)) {
  failures.push(`electronBuilderVersion is ${metadata.electronBuilderVersion}`);
}
validateAsset('arm64', arm64Dmg);
validateAsset('x86_64', x64Dmg);
if (failures.length) throw new Error(`macOS build metadata failed: ${failures.join('; ')}`);
NODE

cp -- "$mac_arm64_dmg" "$staging_dir/DesmosLock-mac.dmg"
cp -- "$mac_x64_dmg" "$staging_dir/DesmosLock-mac-intel.dmg"
cp -- "$windows_installer" "$staging_dir/DesmosLock-setup.exe"
cp -- "$linux_installer" "$staging_dir/DesmosLock.AppImage"
chmod 0755 "$staging_dir/DesmosLock.AppImage"

mac_arm64_sha=$(shasum -a 256 "$staging_dir/DesmosLock-mac.dmg" | awk '{print $1}')
mac_x64_sha=$(shasum -a 256 "$staging_dir/DesmosLock-mac-intel.dmg" | awk '{print $1}')
windows_sha=$(shasum -a 256 "$staging_dir/DesmosLock-setup.exe" | awk '{print $1}')
linux_sha=$(shasum -a 256 "$staging_dir/DesmosLock.AppImage" | awk '{print $1}')
windows_payload_sha=$(shasum -a 256 "$windows_payload" | awk '{print $1}')
windows_application_archive_sha=$(shasum -a 256 "$windows_application_archive" | awk '{print $1}')
mac_arm64_bytes=$(wc -c < "$staging_dir/DesmosLock-mac.dmg" | tr -d ' ')
mac_x64_bytes=$(wc -c < "$staging_dir/DesmosLock-mac-intel.dmg" | tr -d ' ')
windows_bytes=$(wc -c < "$staging_dir/DesmosLock-setup.exe" | tr -d ' ')
linux_bytes=$(wc -c < "$staging_dir/DesmosLock.AppImage" | tr -d ' ')
windows_payload_bytes=$(wc -c < "$windows_payload" | tr -d ' ')
windows_application_archive_bytes=$(wc -c < "$windows_application_archive" | tr -d ' ')
windows_run_json_sha=$(shasum -a 256 "$windows_run_json" | awk '{print $1}')
windows_artifact_json_sha=$(shasum -a 256 "$windows_artifact_json" | awk '{print $1}')
windows_artifact_zip_sha=$(shasum -a 256 "$windows_artifact_zip" | awk '{print $1}')
linux_run_json_sha=$(shasum -a 256 "$linux_run_json" | awk '{print $1}')
linux_artifact_json_sha=$(shasum -a 256 "$linux_artifact_json" | awk '{print $1}')
linux_artifact_zip_sha=$(shasum -a 256 "$linux_artifact_zip" | awk '{print $1}')
windows_artifact_api_digest=$(node -p \
  "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).digest" \
  "$windows_artifact_json")
linux_artifact_api_digest=$(node -p \
  "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).digest" \
  "$linux_artifact_json")
assembled_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

node - "$staging_dir/RELEASE-PROVENANCE.json" "$mac_build_metadata" \
  "$canonical_source_repository" "$workflow_repository" \
  "$source_sha" "$trusted_branch" "$assembled_at" \
  "$windows_run_id" "$windows_artifact_id" "$windows_run_attempt" \
  "$linux_run_id" "$linux_artifact_id" "$linux_run_attempt" \
  "$mac_arm64_sha" "$mac_x64_sha" "$windows_sha" "$linux_sha" \
  "$mac_arm64_bytes" "$mac_x64_bytes" "$windows_bytes" "$linux_bytes" \
  "$windows_payload_sha" "$windows_payload_bytes" \
  "$windows_application_archive_sha" "$windows_application_archive_bytes" \
  "$windows_run_json_sha" "$windows_artifact_json_sha" "$windows_artifact_zip_sha" \
  "$linux_run_json_sha" "$linux_artifact_json_sha" "$linux_artifact_zip_sha" \
  "$windows_artifact_api_digest" "$linux_artifact_api_digest" <<'NODE'
const fs = require('fs');
const [
  output, macMetadataFile, repository, workflowRepository,
  sourceSha, trustedBranch, assembledAt,
  windowsRunId, windowsArtifactId, windowsRunAttempt,
  linuxRunId, linuxArtifactId, linuxRunAttempt,
  macArm64Sha, macX64Sha, windowsSha, linuxSha,
  macArm64Bytes, macX64Bytes, windowsBytes, linuxBytes,
  windowsPayloadSha, windowsPayloadBytes,
  windowsApplicationArchiveSha, windowsApplicationArchiveBytes,
  windowsRunJsonSha, windowsArtifactJsonSha, windowsArtifactZipSha,
  linuxRunJsonSha, linuxArtifactJsonSha, linuxArtifactZipSha,
  windowsArtifactApiDigest, linuxArtifactApiDigest,
] = process.argv.slice(2);
const macMetadata = JSON.parse(fs.readFileSync(macMetadataFile, 'utf8'));
const provenance = {
  schemaVersion: 1,
  release: {
    tag: 'v1.0.1',
    version: '1.0.1',
    assembledAtUtc: assembledAt,
    assembler: 'desktop/scripts/assemble-release.sh',
  },
  source: { repository, commit: sourceSha, trustedBranch },
  builds: {
    macos: {
      method: 'local-macos',
      signing: 'ad-hoc',
      notarized: false,
      hardenedRuntime: true,
      builtAtUtc: macMetadata.builtAtUtc,
      nodeVersion: macMetadata.nodeVersion,
      npmVersion: macMetadata.npmVersion,
      electronBuilderVersion: macMetadata.electronBuilderVersion,
    },
    windows: {
      method: 'github-actions',
      workflowRepository,
      runId: Number(windowsRunId),
      runAttempt: Number(windowsRunAttempt),
      artifactId: Number(windowsArtifactId),
      artifactName: `installer-windows-${sourceSha}`,
      payloadMachine: '0x8664',
      payloadBytes: Number(windowsPayloadBytes),
      payloadSha256: windowsPayloadSha,
      applicationArchiveBytes: Number(windowsApplicationArchiveBytes),
      applicationArchiveSha256: windowsApplicationArchiveSha,
      wrapperMachine: '0x014c',
    },
    linux: {
      method: 'github-actions',
      workflowRepository,
      runId: Number(linuxRunId),
      runAttempt: Number(linuxRunAttempt),
      artifactId: Number(linuxArtifactId),
      artifactName: `installer-linux-${sourceSha}`,
    },
  },
  evidence: {
    windows: {
      runJsonSha256: windowsRunJsonSha,
      artifactJsonSha256: windowsArtifactJsonSha,
      artifactZipSha256: windowsArtifactZipSha,
      artifactApiDigest: windowsArtifactApiDigest,
    },
    linux: {
      runJsonSha256: linuxRunJsonSha,
      artifactJsonSha256: linuxArtifactJsonSha,
      artifactZipSha256: linuxArtifactZipSha,
      artifactApiDigest: linuxArtifactApiDigest,
    },
  },
  assets: {
    'DesmosLock-mac.dmg': { targetArchitecture: 'arm64', bytes: Number(macArm64Bytes), sha256: macArm64Sha },
    'DesmosLock-mac-intel.dmg': { targetArchitecture: 'x86_64', bytes: Number(macX64Bytes), sha256: macX64Sha },
    'DesmosLock-setup.exe': { targetArchitecture: 'x64', bytes: Number(windowsBytes), sha256: windowsSha },
    'DesmosLock.AppImage': { targetArchitecture: 'x64', bytes: Number(linuxBytes), sha256: linuxSha },
  },
  verification: {
    macos: ['hdiutil verify', 'codesign --verify --deep --strict'],
    actionsArtifactsBoundToSourceCommit: true,
    assembledOfflineWithoutPublisherCredential: true,
  },
};
fs.writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
NODE

(
  cd "$staging_dir"
  shasum -a 256 \
    DesmosLock-mac.dmg \
    DesmosLock-mac-intel.dmg \
    DesmosLock-setup.exe \
    DesmosLock.AppImage \
    RELEASE-PROVENANCE.json > SHA256SUMS.txt
  shasum -a 256 --check SHA256SUMS.txt
)

asset_count=$(find "$staging_dir" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')
[[ "$asset_count" -eq 6 ]] || fail "expected exactly six assembled files; found $asset_count"
mv -- "$staging_dir" "$output_dir"

trap - EXIT INT TERM
case "$temp_root" in
  "$output_parent"/.desmoslock-assemble.*) rm -rf -- "$temp_root" ;;
  *) fail "refusing unexpected cleanup path: $temp_root" ;;
esac

printf 'PASS: assembled exactly six release files offline in %s\n' "$output_dir"
printf 'No network client ran and no release was created or modified.\n'
