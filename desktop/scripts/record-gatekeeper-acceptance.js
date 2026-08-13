'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  validateRepository,
  validateSha,
  validateUtcSeconds,
} = require('./provenance-contract');

const RELEASE_REPOSITORY = 'desmoslock/desmoslock-releases';
const RELEASE_ORIGIN = 'https://github.com';
const RELEASE_TARGET_COMMIT = '5b110b5de3262b7bf8ca1c540a94da930ace8017';
const TAG = 'v1.0.1';
const RECEIPT_TYPE = 'gatekeeper-host-acceptance';
const EXPECTED_FILES = [
  'DesmosLock-mac.dmg',
  'DesmosLock-mac-intel.dmg',
  'DesmosLock-setup.exe',
  'DesmosLock.AppImage',
  'RELEASE-PROVENANCE.json',
  'SHA256SUMS.txt',
];
const CHECKSUM_FILES = EXPECTED_FILES.filter((name) => name !== 'SHA256SUMS.txt');
const ROLE_SCOPES = Object.freeze({
  'mac-mini': Object.freeze(['arm64-native']),
  macbook: Object.freeze(['arm64-native', 'x64-rosetta']),
});
const COMMON_OPTION_KEYS = [
  'host-role', 'candidate-dir', 'draft-release-json', 'arm64-dmg', 'arm64-browser', 'arm64-url',
  'arm64-fresh-download', 'arm64-denial-class', 'arm64-observed-message',
  'arm64-damaged-observed', 'arm64-open-anyway-launched', 'arm64-subsequent-launch',
  'output',
];
const X64_OPTION_KEYS = [
  'x64-dmg', 'x64-browser', 'x64-url', 'x64-fresh-download', 'x64-denial-class',
  'x64-observed-message', 'x64-damaged-observed', 'x64-open-anyway-launched',
  'x64-subsequent-launch', 'x64-rosetta-launched',
];

function fail(message) {
  throw new Error(message);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function requireExactObjectKeys(value, expected, label) {
  requireObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields must be exactly: ${wanted.join(', ')}`);
  }
  return value;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail(`every option requires one value; invalid option near ${flag || '<end>'}`);
    }
    const key = flag.slice(2);
    if (Object.hasOwn(values, key)) fail(`duplicate option: ${flag}`);
    values[key] = value;
  }
  return values;
}

function expectedOptionKeys(role) {
  if (!Object.hasOwn(ROLE_SCOPES, role)) fail('--host-role must be mac-mini or macbook');
  return role === 'macbook' ? [...COMMON_OPTION_KEYS, ...X64_OPTION_KEYS] : [...COMMON_OPTION_KEYS];
}

function requireExactKeys(values, expected) {
  const actual = Object.keys(values).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`options must be exactly: ${wanted.map((key) => `--${key}`).join(', ')}`);
  }
}

function hashBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(file) {
  return hashBytes(fs.readFileSync(file));
}

function requireRegularFile(file, label) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular, non-symlink file`);
  return info;
}

function resolveRegularFile(fileArgument, label) {
  const requested = path.resolve(fileArgument);
  requireRegularFile(requested, label);
  const resolved = fs.realpathSync(requested);
  requireRegularFile(resolved, label);
  return resolved;
}

function pathIsInside(directory, target) {
  const relative = path.relative(directory, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveNewPrivateOutput(outputArgument, candidateDir, label = 'receipt') {
  const requested = path.resolve(outputArgument);
  const parent = fs.realpathSync(path.dirname(requested));
  const output = path.join(parent, path.basename(requested));
  if (pathIsInside(candidateDir, output)) fail(`${label} must remain outside the six-asset directory`);
  if (fs.existsSync(output)) fail(`${label} output must not already exist`);
  return output;
}

function parseChecksumManifest(text) {
  const entries = {};
  for (const line of text.trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || Object.hasOwn(entries, match[2])) fail('SHA256SUMS.txt is malformed or duplicated');
    entries[match[2]] = match[1];
  }
  if (JSON.stringify(Object.keys(entries)) !== JSON.stringify(CHECKSUM_FILES)) {
    fail('SHA256SUMS.txt must contain the five exact ordered entries');
  }
  return entries;
}

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive safe integer`);
  return value;
}

function validateDraftDownloadUrl(value, filename, expectedToken) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${filename} download URL is invalid`);
  }
  const expectedPrefix = `/${RELEASE_REPOSITORY}/releases/download/`;
  const escapedRepository = RELEASE_REPOSITORY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathMatch = new RegExp(`^/${escapedRepository}/releases/download/(untagged-[0-9a-f]{20})/([^/]+)$`)
    .exec(url.pathname);
  if (url.origin !== RELEASE_ORIGIN || !url.pathname.startsWith(expectedPrefix) ||
      !pathMatch || pathMatch[2] !== filename ||
      url.pathname.includes('%') || url.username || url.password || url.search || url.hash ||
      url.toString() !== value || (expectedToken !== undefined && pathMatch[1] !== expectedToken)) {
    fail(`${filename} must use its exact credential-free GitHub draft asset URL`);
  }
  return { url: url.toString(), untaggedToken: pathMatch[1] };
}

function validateReleaseNotes(body) {
  if (typeof body !== 'string' ||
      !body.includes('The macOS builds are ad-hoc signed.') ||
      !body.includes('They are not Developer ID signed and are not notarized.') ||
      !body.includes('System Settings > Privacy & Security and choose Open Anyway once.') ||
      !body.includes('Do not remove quarantine or disable Gatekeeper.') ||
      /(?:^|\s)xattr(?:\s|$)|spctl\s+--master-disable/i.test(body)) {
    fail('draft release notes must disclose ad-hoc signing, no notarization, Open Anyway, and no bypass advice');
  }
  return hashBytes(body);
}

function validateObservation(label, observation, { expectedBrowser, requireRosetta = false } = {}) {
  if (observation.browser !== expectedBrowser) fail(`${label} must be freshly downloaded with ${expectedBrowser}`);
  if (observation.freshDownload !== 'yes') fail(`${label} must attest a fresh browser download`);
  if (observation.denialClass !== 'unidentified-developer-open-anyway') {
    fail(`${label} denial class must be unidentified-developer-open-anyway`);
  }
  if (typeof observation.observedMessage !== 'string' ||
      observation.observedMessage.length < 5 || observation.observedMessage.length > 500 ||
      /[\r\n]/.test(observation.observedMessage)) {
    fail(`${label} observed message must be one nonempty line of at most 500 characters`);
  }
  if (/(?:\bdamaged\b|\bwill damage\b|\bmov(?:e|ed) to (?:the )?(?:trash|bin)\b)/i.test(observation.observedMessage) ||
      observation.damagedObserved !== 'no') {
    fail(`${label} displayed a forbidden Gatekeeper classification`);
  }
  if (observation.openAnywayLaunched !== 'yes') fail(`${label} did not launch after Open Anyway`);
  if (observation.subsequentLaunch !== 'yes') fail(`${label} did not pass a subsequent normal launch`);
  if (requireRosetta && observation.rosettaLaunched !== 'yes') fail(`${label} did not launch under Rosetta`);
  return observation;
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) fail(`${command} ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function fingerprintHardwareIdentifier(identifier) {
  if (typeof identifier !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier)) {
    fail('stable hardware identifier is unavailable or malformed');
  }
  return hashBytes(`desmoslock-gatekeeper-host-v1\n${identifier.toLowerCase()}`);
}

function readHostFingerprint() {
  const result = spawnSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) fail('stable hardware identifier is unavailable or malformed');
  const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(result.stdout);
  return fingerprintHardwareIdentifier(match?.[1]);
}

function classifyHardwareFamily(modelName) {
  if (typeof modelName !== 'string') fail('hardware family is unavailable or unsupported');
  if (/^Mac mini$/i.test(modelName.trim())) return 'mac-mini';
  if (/^MacBook(?: Air| Pro)?$/i.test(modelName.trim())) return 'macbook';
  fail('hardware family is unavailable or unsupported');
}

function readHardwareFamily() {
  const result = spawnSync('/usr/sbin/system_profiler', ['SPHardwareDataType'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.status !== 0) fail('hardware family is unavailable or unsupported');
  const match = /^\s*Model Name:\s*(.+?)\s*$/m.exec(result.stdout);
  return classifyHardwareFamily(match?.[1]);
}

function requireQuarantine(file, label) {
  const result = spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout.trim()) fail(`${label} is missing browser quarantine metadata`);
}

function verifyDmg(file, architecture) {
  const verifier = path.join(__dirname, 'verify-macos-dmg.sh');
  const result = spawnSync(verifier, [file, architecture], { stdio: 'inherit' });
  if (result.status !== 0) fail(`strict DMG verification failed for ${path.basename(file)}`);
}

function sameFile(left, right) {
  const a = fs.statSync(left);
  const b = fs.statSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}

function loadCandidate(candidateArgument) {
  const candidateDir = fs.realpathSync(candidateArgument);
  if (!fs.lstatSync(candidateDir).isDirectory()) fail('candidate directory must be a directory');
  const candidateEntries = fs.readdirSync(candidateDir).sort();
  if (JSON.stringify(candidateEntries) !== JSON.stringify([...EXPECTED_FILES].sort())) {
    fail('candidate directory must contain exactly the six immutable release assets');
  }
  for (const filename of EXPECTED_FILES) requireRegularFile(path.join(candidateDir, filename), filename);

  const manifestPath = path.join(candidateDir, 'SHA256SUMS.txt');
  const checksums = parseChecksumManifest(fs.readFileSync(manifestPath, 'utf8'));
  for (const [filename, expected] of Object.entries(checksums)) {
    if (hashFile(path.join(candidateDir, filename)) !== expected) fail(`${filename} does not match SHA256SUMS.txt`);
  }

  const provenance = JSON.parse(fs.readFileSync(path.join(candidateDir, 'RELEASE-PROVENANCE.json'), 'utf8'));
  if (provenance?.schemaVersion !== 1 || provenance?.release?.tag !== TAG ||
      provenance?.release?.version !== '1.0.1') fail('release provenance identity is invalid');
  const sourceRepository = validateRepository(provenance?.source?.repository, 'source.repository');
  const sourceSha = validateSha(provenance?.source?.commit, 'source.commit');
  for (const filename of EXPECTED_FILES.slice(0, 4)) {
    if (provenance?.assets?.[filename]?.sha256 !== checksums[filename]) {
      fail(`${filename} provenance hash does not match SHA256SUMS.txt`);
    }
  }

  const assetSha256 = Object.fromEntries(EXPECTED_FILES.map((filename) => [
    filename,
    filename === 'SHA256SUMS.txt' ? hashFile(manifestPath) : checksums[filename],
  ]));
  const assetSize = Object.fromEntries(EXPECTED_FILES.map((filename) => [
    filename,
    fs.statSync(path.join(candidateDir, filename)).size,
  ]));
  return {
    candidateDir,
    manifestSha256: assetSha256['SHA256SUMS.txt'],
    assetSha256,
    assetSize,
    source: { repository: sourceRepository, commit: sourceSha },
    release: { repository: RELEASE_REPOSITORY, tag: TAG },
    provenance,
  };
}

function validateDraftReleaseSnapshot(snapshot, candidate) {
  requireExactObjectKeys(snapshot, [
    'releaseId', 'repository', 'tag', 'targetCommitish', 'draft', 'prerelease',
    'immutable', 'releaseNotesSha256', 'untaggedToken', 'assets',
  ], 'draft release snapshot');
  requirePositiveSafeInteger(snapshot.releaseId, 'draft release ID');
  if (snapshot.repository !== RELEASE_REPOSITORY || snapshot.tag !== TAG ||
      snapshot.targetCommitish !== RELEASE_TARGET_COMMIT || snapshot.draft !== true ||
      snapshot.prerelease !== false || snapshot.immutable !== false ||
      !/^[0-9a-f]{64}$/.test(snapshot.releaseNotesSha256) ||
      !/^untagged-[0-9a-f]{20}$/.test(snapshot.untaggedToken)) {
    fail('draft release identity is invalid');
  }
  const seenAssetIds = new Set();
  requireExactObjectKeys(snapshot.assets, EXPECTED_FILES, 'draft release assets');
  for (const filename of EXPECTED_FILES) {
    const asset = requireExactObjectKeys(snapshot.assets[filename], [
      'assetId', 'size', 'sha256', 'browserDownloadUrl',
    ], `draft release asset ${filename}`);
    requirePositiveSafeInteger(asset.assetId, `${filename} draft asset ID`);
    if (seenAssetIds.has(asset.assetId)) fail('draft release asset IDs must be unique');
    seenAssetIds.add(asset.assetId);
    requirePositiveSafeInteger(asset.size, `${filename} draft asset size`);
    if (!/^[0-9a-f]{64}$/.test(asset.sha256)) fail(`${filename} draft asset digest is invalid`);
    validateDraftDownloadUrl(asset.browserDownloadUrl, filename, snapshot.untaggedToken);
    if (candidate && (asset.sha256 !== candidate.assetSha256[filename] ||
        asset.size !== candidate.assetSize[filename])) {
      fail(`${filename} draft asset does not match the live candidate`);
    }
  }
  return snapshot;
}

function loadDraftReleaseSnapshot(snapshotArgument, candidate) {
  const snapshotPath = resolveRegularFile(snapshotArgument, 'draft release API snapshot');
  if (pathIsInside(candidate.candidateDir, snapshotPath)) {
    fail('draft release API snapshot must remain outside the six-asset directory');
  }
  if ((fs.lstatSync(snapshotPath).mode & 0o077) !== 0) {
    fail('draft release API snapshot must not be readable or writable by group/others');
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    fail('draft release API snapshot is not valid JSON');
  }
  requireObject(raw, 'draft release API snapshot');
  const releaseId = requirePositiveSafeInteger(raw.id, 'draft release ID');
  if (raw.url !== `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/${releaseId}` ||
      raw.assets_url !== `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/${releaseId}/assets` ||
      raw.tag_name !== TAG || raw.target_commitish !== RELEASE_TARGET_COMMIT ||
      raw.draft !== true || raw.prerelease !== false || raw.published_at !== null ||
      raw.immutable !== false ||
      !Array.isArray(raw.assets) || raw.assets.length !== EXPECTED_FILES.length) {
    fail('draft release API snapshot identity is invalid');
  }
  const releaseNotesSha256 = validateReleaseNotes(raw.body);

  const rawAssets = new Map();
  const rawAssetIds = new Set();
  let untaggedToken;
  for (const rawAsset of raw.assets) {
    if (!rawAsset || typeof rawAsset !== 'object' || typeof rawAsset.name !== 'string' ||
        rawAssets.has(rawAsset.name) || !EXPECTED_FILES.includes(rawAsset.name)) {
      fail('draft release API snapshot assets are missing, duplicated, or unexpected');
    }
    const assetId = requirePositiveSafeInteger(rawAsset.id, `${rawAsset.name} draft asset ID`);
    if (rawAssetIds.has(assetId)) fail('draft release asset IDs must be unique');
    rawAssetIds.add(assetId);
    const size = requirePositiveSafeInteger(rawAsset.size, `${rawAsset.name} draft asset size`);
    if (rawAsset.state !== 'uploaded' ||
        rawAsset.url !== `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/assets/${assetId}` ||
        rawAsset.digest !== `sha256:${candidate.assetSha256[rawAsset.name]}` ||
        size !== candidate.assetSize[rawAsset.name]) {
      fail(`${rawAsset.name} draft asset API evidence does not match the live candidate`);
    }
    const validatedUrl = validateDraftDownloadUrl(rawAsset.browser_download_url, rawAsset.name, untaggedToken);
    untaggedToken ??= validatedUrl.untaggedToken;
    rawAssets.set(rawAsset.name, {
      assetId,
      size,
      sha256: rawAsset.digest.slice('sha256:'.length),
      browserDownloadUrl: validatedUrl.url,
    });
  }
  if (rawAssets.size !== EXPECTED_FILES.length ||
      raw.html_url !== `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${untaggedToken}`) {
    fail('draft release API snapshot URLs are inconsistent');
  }
  const snapshot = {
    releaseId,
    repository: RELEASE_REPOSITORY,
    tag: TAG,
    targetCommitish: raw.target_commitish,
    draft: true,
    prerelease: false,
    immutable: false,
    releaseNotesSha256,
    untaggedToken,
    assets: Object.fromEntries(EXPECTED_FILES.map((filename) => [filename, rawAssets.get(filename)])),
  };
  return validateDraftReleaseSnapshot(snapshot, candidate);
}

function receiptTest(asset, candidate, draftRelease) {
  const draftAsset = draftRelease.assets[asset.filename];
  return {
    id: asset.id,
    filename: asset.filename,
    architecture: asset.architecture,
    automatedEvidence: {
      sha256: candidate.assetSha256[asset.filename],
      quarantinePresent: true,
      hdiutilVerify: true,
      codesignDeepStrict: true,
    },
    witnessedOperatorAttestation: {
      kind: 'witnessed-operator-attestation',
      draftDownloadContext: 'logged-in-collaborator-browser',
      browser: asset.observation.browser,
      draftReleaseId: draftRelease.releaseId,
      draftAssetId: draftAsset.assetId,
      githubSha256: draftAsset.sha256,
      draftBrowserDownloadUrl: asset.url,
      freshBrowserDownload: true,
      executionMode: asset.id === 'x64-rosetta' ? 'rosetta' : 'native',
      denialClass: asset.observation.denialClass,
      observedMessage: asset.observation.observedMessage,
      damagedMessageObserved: false,
      openAnywayLaunched: true,
      subsequentLaunchWorked: true,
      rosettaLaunched: asset.id === 'x64-rosetta',
    },
  };
}

function validateHostReceipt(receipt, expectedRole, candidate) {
  requireExactObjectKeys(receipt, [
    'schemaVersion', 'receiptType', 'recordedAtUtc', 'source', 'release', 'candidate',
    'draftRelease', 'host', 'policy', 'tests', 'verification',
  ], 'host receipt');
  if (receipt.schemaVersion !== 3 || receipt.receiptType !== RECEIPT_TYPE) fail('host receipt schema/type is invalid');
  validateUtcSeconds(receipt.recordedAtUtc, 'recordedAtUtc');
  requireExactObjectKeys(receipt.source, ['repository', 'commit'], 'source');
  validateRepository(receipt.source.repository, 'source.repository');
  validateSha(receipt.source.commit, 'source.commit');
  requireExactObjectKeys(receipt.release, ['repository', 'tag'], 'release');
  if (receipt.release.repository !== RELEASE_REPOSITORY || receipt.release.tag !== TAG) fail('release identity is invalid');

  requireExactObjectKeys(receipt.candidate, ['manifestSha256', 'assetSha256'], 'candidate');
  if (!/^[0-9a-f]{64}$/.test(receipt.candidate.manifestSha256)) fail('candidate manifest digest is invalid');
  requireExactObjectKeys(receipt.candidate.assetSha256, EXPECTED_FILES, 'candidate.assetSha256');
  for (const filename of EXPECTED_FILES) {
    if (!/^[0-9a-f]{64}$/.test(receipt.candidate.assetSha256[filename])) fail(`${filename} receipt hash is invalid`);
  }
  if (receipt.candidate.assetSha256['SHA256SUMS.txt'] !== receipt.candidate.manifestSha256) {
    fail('receipt manifest digest is inconsistent');
  }
  validateDraftReleaseSnapshot(receipt.draftRelease, candidate);

  requireExactObjectKeys(receipt.host, [
    'role', 'scope', 'hardwareFamily', 'fingerprintSha256', 'macosProductVersion', 'macosBuildVersion',
    'architecture', 'rosettaAcceptanceRequired', 'rosettaCapabilityVerified',
  ], 'host');
  if (receipt.host.role !== expectedRole || !Object.hasOwn(ROLE_SCOPES, expectedRole)) fail('host role is invalid');
  if (JSON.stringify(receipt.host.scope) !== JSON.stringify(ROLE_SCOPES[expectedRole])) fail('host scope is invalid');
  if (receipt.host.hardwareFamily !== expectedRole) fail('host hardware family does not match its role');
  if (!/^[0-9a-f]{64}$/.test(receipt.host.fingerprintSha256)) fail('host fingerprint is invalid');
  if (!/^\d+(?:\.\d+){1,2}$/.test(receipt.host.macosProductVersion) ||
      !/^[0-9A-Za-z]+$/.test(receipt.host.macosBuildVersion) || receipt.host.architecture !== 'arm64') {
    fail('host platform evidence is invalid');
  }
  const rosettaRequired = expectedRole === 'macbook';
  if (receipt.host.rosettaAcceptanceRequired !== rosettaRequired ||
      receipt.host.rosettaCapabilityVerified !== rosettaRequired) fail('host Rosetta evidence is invalid');

  requireExactObjectKeys(receipt.policy, [
    'passingDenialClass', 'spctlAcceptanceExpected', 'quarantineRemovalUsed',
    'receiptIsPublicReleaseAsset', 'dialogAndLaunchEvidenceSource',
  ], 'policy');
  if (receipt.policy.passingDenialClass !== 'unidentified-developer-open-anyway' ||
      receipt.policy.spctlAcceptanceExpected !== false || receipt.policy.quarantineRemovalUsed !== false ||
      receipt.policy.receiptIsPublicReleaseAsset !== false ||
      receipt.policy.dialogAndLaunchEvidenceSource !== 'witnessed-operator-attestation') {
    fail('host receipt policy is invalid');
  }

  if (!Array.isArray(receipt.tests) || receipt.tests.length !== ROLE_SCOPES[expectedRole].length) {
    fail('host receipt test count is invalid');
  }
  for (let index = 0; index < receipt.tests.length; index += 1) {
    const test = receipt.tests[index];
    const id = ROLE_SCOPES[expectedRole][index];
    const x64 = id === 'x64-rosetta';
    const filename = x64 ? 'DesmosLock-mac-intel.dmg' : 'DesmosLock-mac.dmg';
    requireExactObjectKeys(test, [
      'id', 'filename', 'architecture', 'automatedEvidence', 'witnessedOperatorAttestation',
    ], `tests[${index}]`);
    if (test.id !== id || test.filename !== filename ||
        test.architecture !== (x64 ? 'x86_64' : 'arm64')) fail(`${id} test identity is invalid`);
    requireExactObjectKeys(test.automatedEvidence, [
      'sha256', 'quarantinePresent', 'hdiutilVerify', 'codesignDeepStrict',
    ], `${id}.automatedEvidence`);
    if (test.automatedEvidence.sha256 !== receipt.candidate.assetSha256[filename] ||
        test.automatedEvidence.quarantinePresent !== true || test.automatedEvidence.hdiutilVerify !== true ||
        test.automatedEvidence.codesignDeepStrict !== true) fail(`${id} automated evidence is invalid`);
    const attestation = requireExactObjectKeys(test.witnessedOperatorAttestation, [
      'kind', 'draftDownloadContext', 'browser', 'draftReleaseId', 'draftAssetId',
      'githubSha256', 'draftBrowserDownloadUrl', 'freshBrowserDownload',
      'executionMode', 'denialClass', 'observedMessage', 'damagedMessageObserved',
      'openAnywayLaunched', 'subsequentLaunchWorked', 'rosettaLaunched',
    ], `${id}.witnessedOperatorAttestation`);
    if (attestation.kind !== 'witnessed-operator-attestation' ||
        attestation.draftDownloadContext !== 'logged-in-collaborator-browser' ||
        attestation.browser !== (x64 ? 'Chrome' : 'Safari') ||
        attestation.draftReleaseId !== receipt.draftRelease.releaseId ||
        attestation.draftAssetId !== receipt.draftRelease.assets[filename].assetId ||
        attestation.githubSha256 !== receipt.draftRelease.assets[filename].sha256 ||
        validateDraftDownloadUrl(attestation.draftBrowserDownloadUrl, filename,
          receipt.draftRelease.untaggedToken).url !== attestation.draftBrowserDownloadUrl ||
        attestation.draftBrowserDownloadUrl !== receipt.draftRelease.assets[filename].browserDownloadUrl ||
        attestation.freshBrowserDownload !== true || attestation.executionMode !== (x64 ? 'rosetta' : 'native') ||
        attestation.denialClass !== 'unidentified-developer-open-anyway' ||
        typeof attestation.observedMessage !== 'string' || attestation.observedMessage.length < 5 ||
        attestation.observedMessage.length > 500 || /[\r\n]/.test(attestation.observedMessage) ||
        /(?:\bdamaged\b|\bwill damage\b|\bmov(?:e|ed) to (?:the )?(?:trash|bin)\b)/i.test(attestation.observedMessage) ||
        attestation.damagedMessageObserved !== false || attestation.openAnywayLaunched !== true ||
        attestation.subsequentLaunchWorked !== true || attestation.rosettaLaunched !== x64) {
      fail(`${id} witnessed operator attestation is invalid`);
    }
  }

  requireExactObjectKeys(receipt.verification, [
    'checksumManifestMatched', 'candidateAssetHashesMatched', 'quarantineReadOnly',
    'hdiutilVerify', 'codesignDeepStrict',
  ], 'verification');
  if (Object.values(receipt.verification).some((value) => value !== true)) fail('host receipt verification is invalid');

  if (candidate) {
    if (JSON.stringify(receipt.source) !== JSON.stringify(candidate.source) ||
        JSON.stringify(receipt.release) !== JSON.stringify(candidate.release) ||
        receipt.candidate.manifestSha256 !== candidate.manifestSha256 ||
        JSON.stringify(receipt.candidate.assetSha256) !== JSON.stringify(candidate.assetSha256)) {
      fail(`${expectedRole} receipt does not match the live candidate`);
    }
  }
  return receipt;
}

function validateReceiptPair(macMiniReceipt, macBookReceipt, candidate) {
  validateHostReceipt(macMiniReceipt, 'mac-mini', candidate);
  validateHostReceipt(macBookReceipt, 'macbook', candidate);
  if (macMiniReceipt.host.fingerprintSha256 === macBookReceipt.host.fingerprintSha256) {
    fail('Mac Mini and MacBook receipts must come from distinct physical hosts');
  }
  if (JSON.stringify(macMiniReceipt.source) !== JSON.stringify(macBookReceipt.source) ||
      JSON.stringify(macMiniReceipt.release) !== JSON.stringify(macBookReceipt.release) ||
      JSON.stringify(macMiniReceipt.draftRelease) !== JSON.stringify(macBookReceipt.draftRelease) ||
      macMiniReceipt.candidate.manifestSha256 !== macBookReceipt.candidate.manifestSha256 ||
      JSON.stringify(macMiniReceipt.candidate.assetSha256) !== JSON.stringify(macBookReceipt.candidate.assetSha256)) {
    fail('host receipts do not bind the same source, release, and six assets');
  }
  return { macMiniReceipt, macBookReceipt };
}

function main(argv) {
  if (process.platform !== 'darwin') fail('Gatekeeper acceptance must run on macOS');
  const options = parseArgs(argv);
  const role = options['host-role'];
  requireExactKeys(options, expectedOptionKeys(role));

  for (const name of [
    'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
    'RELEASES_REPO_TOKEN', 'RELEASES_REPO_READ_TOKEN',
  ]) {
    if (process.env[name] !== undefined) fail(`${name} must not be present during acceptance recording`);
  }

  const candidate = loadCandidate(options['candidate-dir']);
  const draftRelease = loadDraftReleaseSnapshot(options['draft-release-json'], candidate);
  const hostArchitecture = commandOutput('/usr/bin/uname', ['-m']);
  if (hostArchitecture !== 'arm64') fail('both required host roles must run on Apple silicon');
  const hardwareFamily = readHardwareFamily();
  if (hardwareFamily !== role) fail('selected host role does not match this physical Mac family');
  if (role === 'macbook') {
    const rosettaProbe = spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true']);
    if (rosettaProbe.status !== 0) fail('Rosetta is unavailable for the required MacBook x64 launch test');
  }

  const assets = [{
    id: 'arm64-native', filename: 'DesmosLock-mac.dmg', architecture: 'arm64',
    path: resolveRegularFile(options['arm64-dmg'], 'arm64-native browser download'),
    url: options['arm64-url'],
    observation: {
      browser: options['arm64-browser'], freshDownload: options['arm64-fresh-download'],
      denialClass: options['arm64-denial-class'], observedMessage: options['arm64-observed-message'],
      damagedObserved: options['arm64-damaged-observed'],
      openAnywayLaunched: options['arm64-open-anyway-launched'],
      subsequentLaunch: options['arm64-subsequent-launch'],
    },
  }];
  if (role === 'macbook') {
    assets.push({
      id: 'x64-rosetta', filename: 'DesmosLock-mac-intel.dmg', architecture: 'x86_64',
      path: resolveRegularFile(options['x64-dmg'], 'x64-rosetta browser download'),
      url: options['x64-url'],
      observation: {
        browser: options['x64-browser'], freshDownload: options['x64-fresh-download'],
        denialClass: options['x64-denial-class'], observedMessage: options['x64-observed-message'],
        damagedObserved: options['x64-damaged-observed'],
        openAnywayLaunched: options['x64-open-anyway-launched'],
        subsequentLaunch: options['x64-subsequent-launch'],
        rosettaLaunched: options['x64-rosetta-launched'],
      },
    });
  }

  for (const asset of assets) {
    requireRegularFile(asset.path, `${asset.id} browser download`);
    if (path.basename(asset.path) !== asset.filename) fail(`${asset.id} download filename is not stable`);
    if (sameFile(asset.path, path.join(candidate.candidateDir, asset.filename))) {
      fail(`${asset.id} test input is the assembled file, not a separate browser download`);
    }
    const draftAsset = draftRelease.assets[asset.filename];
    const validatedUrl = validateDraftDownloadUrl(asset.url, asset.filename, draftRelease.untaggedToken);
    if (validatedUrl.url !== draftAsset.browserDownloadUrl) {
      fail(`${asset.id} download URL does not match the saved draft asset API evidence`);
    }
    asset.url = validatedUrl.url;
    validateObservation(asset.id, asset.observation, {
      expectedBrowser: asset.id === 'x64-rosetta' ? 'Chrome' : 'Safari',
      requireRosetta: asset.id === 'x64-rosetta',
    });
    requireQuarantine(asset.path, asset.id);
    if (hashFile(asset.path) !== candidate.assetSha256[asset.filename]) {
      fail(`${asset.id} browser download does not match the accepted final DMG`);
    }
    verifyDmg(asset.path, asset.architecture);
  }
  if (assets.length === 2 && sameFile(assets[0].path, assets[1].path)) {
    fail('MacBook ARM64 and x64 tests must use separate downloads');
  }

  const output = resolveNewPrivateOutput(options.output, candidate.candidateDir);
  const receipt = {
    schemaVersion: 3,
    receiptType: RECEIPT_TYPE,
    recordedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: candidate.source,
    release: candidate.release,
    candidate: {
      manifestSha256: candidate.manifestSha256,
      assetSha256: candidate.assetSha256,
    },
    draftRelease,
    host: {
      role,
      scope: [...ROLE_SCOPES[role]],
      hardwareFamily,
      fingerprintSha256: readHostFingerprint(),
      macosProductVersion: commandOutput('/usr/bin/sw_vers', ['-productVersion']),
      macosBuildVersion: commandOutput('/usr/bin/sw_vers', ['-buildVersion']),
      architecture: hostArchitecture,
      rosettaAcceptanceRequired: role === 'macbook',
      rosettaCapabilityVerified: role === 'macbook',
    },
    policy: {
      passingDenialClass: 'unidentified-developer-open-anyway',
      spctlAcceptanceExpected: false,
      quarantineRemovalUsed: false,
      receiptIsPublicReleaseAsset: false,
      dialogAndLaunchEvidenceSource: 'witnessed-operator-attestation',
    },
    tests: assets.map((asset) => receiptTest(asset, candidate, draftRelease)),
    verification: {
      checksumManifestMatched: true,
      candidateAssetHashesMatched: true,
      quarantineReadOnly: true,
      hdiutilVerify: true,
      codesignDeepStrict: true,
    },
  };
  validateHostReceipt(receipt, role, candidate);
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`PASS: private ${role} Gatekeeper acceptance receipt written to ${output}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CHECKSUM_FILES,
  EXPECTED_FILES,
  RECEIPT_TYPE,
  RELEASE_REPOSITORY,
  RELEASE_TARGET_COMMIT,
  ROLE_SCOPES,
  TAG,
  classifyHardwareFamily,
  expectedOptionKeys,
  fingerprintHardwareIdentifier,
  hashFile,
  loadCandidate,
  loadDraftReleaseSnapshot,
  parseArgs,
  parseChecksumManifest,
  pathIsInside,
  requireRegularFile,
  resolveRegularFile,
  resolveNewPrivateOutput,
  sameFile,
  validateDraftDownloadUrl,
  validateDraftReleaseSnapshot,
  validateReleaseNotes,
  validateHostReceipt,
  validateObservation,
  validateReceiptPair,
};
