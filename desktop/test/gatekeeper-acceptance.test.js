'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CHECKSUM_FILES,
  EXPECTED_FILES,
  RELEASE_REPOSITORY,
  RELEASE_TARGET_COMMIT,
  ROLE_SCOPES,
  TAG,
  classifyHardwareFamily,
  expectedOptionKeys,
  fingerprintHardwareIdentifier,
  loadDraftReleaseSnapshot,
  parseChecksumManifest,
  validateDraftDownloadUrl,
  validateDraftReleaseSnapshot,
  validateReleaseNotes,
  validateHostReceipt,
  validateObservation,
  validateReceiptPair,
} = require('../scripts/record-gatekeeper-acceptance');

const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const sourceRepository = 'danielholguin31/desmoslock';
const releaseTarget = RELEASE_TARGET_COMMIT;
const draftReleaseId = 370225506;
const untaggedToken = 'untagged-e0bdd4e2f98d728bbb84';
const releaseNotes = 'The macOS builds are ad-hoc signed. They are not Developer ID signed and are not notarized. On first launch, open System Settings > Privacy & Security and choose Open Anyway once. Do not remove quarantine or disable Gatekeeper.';
const hashes = Object.fromEntries(EXPECTED_FILES.map((filename, index) => [
  filename,
  (index + 1).toString(16).repeat(64),
]));
const sizes = Object.fromEntries(EXPECTED_FILES.map((filename, index) => [
  filename,
  1000 + index,
]));
const draftAssets = Object.fromEntries(EXPECTED_FILES.map((filename, index) => [
  filename,
  {
    assetId: 513534820 + index,
    size: sizes[filename],
    sha256: hashes[filename],
    browserDownloadUrl: `https://github.com/${RELEASE_REPOSITORY}/releases/download/${untaggedToken}/${filename}`,
  },
]));
const draftRelease = {
  releaseId: draftReleaseId,
  repository: RELEASE_REPOSITORY,
  tag: TAG,
  targetCommitish: releaseTarget,
  draft: true,
  prerelease: false,
  immutable: false,
  releaseNotesSha256: require('node:crypto').createHash('sha256').update(releaseNotes).digest('hex'),
  untaggedToken,
  assets: draftAssets,
};
const candidate = {
  source: { repository: sourceRepository, commit: sourceSha },
  release: { repository: RELEASE_REPOSITORY, tag: TAG },
  manifestSha256: hashes['SHA256SUMS.txt'],
  assetSha256: hashes,
  assetSize: sizes,
};

function rawDraftRelease(overrides = {}) {
  return {
    url: `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/${draftReleaseId}`,
    assets_url: `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/${draftReleaseId}/assets`,
    html_url: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${untaggedToken}`,
    id: draftReleaseId,
    tag_name: TAG,
    target_commitish: releaseTarget,
    draft: true,
    prerelease: false,
    immutable: false,
    body: releaseNotes,
    published_at: null,
    assets: EXPECTED_FILES.map((filename) => ({
      url: `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/assets/${draftAssets[filename].assetId}`,
      id: draftAssets[filename].assetId,
      name: filename,
      state: 'uploaded',
      size: sizes[filename],
      digest: `sha256:${hashes[filename]}`,
      browser_download_url: draftAssets[filename].browserDownloadUrl,
    })),
    ...overrides,
  };
}

function inputObservation(overrides = {}) {
  return {
    browser: 'Safari',
    freshDownload: 'yes',
    denialClass: 'unidentified-developer-open-anyway',
    observedMessage: 'DesmosLock cannot be opened because the developer cannot be verified.',
    damagedObserved: 'no',
    openAnywayLaunched: 'yes',
    subsequentLaunch: 'yes',
    ...overrides,
  };
}

function witnessedAttestation(id, overrides = {}) {
  const x64 = id === 'x64-rosetta';
  const filename = x64 ? 'DesmosLock-mac-intel.dmg' : 'DesmosLock-mac.dmg';
  return {
    kind: 'witnessed-operator-attestation',
    draftDownloadContext: 'logged-in-collaborator-browser',
    browser: x64 ? 'Chrome' : 'Safari',
    draftReleaseId,
    draftAssetId: draftAssets[filename].assetId,
    githubSha256: hashes[filename],
    draftBrowserDownloadUrl: draftAssets[filename].browserDownloadUrl,
    freshBrowserDownload: true,
    executionMode: x64 ? 'rosetta' : 'native',
    denialClass: 'unidentified-developer-open-anyway',
    observedMessage: 'DesmosLock cannot be opened because the developer cannot be verified.',
    damagedMessageObserved: false,
    openAnywayLaunched: true,
    subsequentLaunchWorked: true,
    rosettaLaunched: x64,
    ...overrides,
  };
}

function receiptTest(id) {
  const x64 = id === 'x64-rosetta';
  const filename = x64 ? 'DesmosLock-mac-intel.dmg' : 'DesmosLock-mac.dmg';
  return {
    id,
    filename,
    architecture: x64 ? 'x86_64' : 'arm64',
    automatedEvidence: {
      sha256: hashes[filename],
      quarantinePresent: true,
      hdiutilVerify: true,
      codesignDeepStrict: true,
    },
    witnessedOperatorAttestation: witnessedAttestation(id),
  };
}

function hostReceipt(role, fingerprint, overrides = {}) {
  const rosettaRequired = role === 'macbook';
  const receipt = {
    schemaVersion: 3,
    receiptType: 'gatekeeper-host-acceptance',
    recordedAtUtc: '2026-08-13T19:45:00Z',
    source: { ...candidate.source },
    release: { ...candidate.release },
    candidate: {
      manifestSha256: candidate.manifestSha256,
      assetSha256: { ...candidate.assetSha256 },
    },
    draftRelease: structuredClone(draftRelease),
    host: {
      role,
      scope: [...ROLE_SCOPES[role]],
      hardwareFamily: role,
      fingerprintSha256: fingerprint,
      macosProductVersion: '26.3',
      macosBuildVersion: '25D125',
      architecture: 'arm64',
      rosettaAcceptanceRequired: rosettaRequired,
      rosettaCapabilityVerified: rosettaRequired,
    },
    policy: {
      passingDenialClass: 'unidentified-developer-open-anyway',
      spctlAcceptanceExpected: false,
      quarantineRemovalUsed: false,
      receiptIsPublicReleaseAsset: false,
      dialogAndLaunchEvidenceSource: 'witnessed-operator-attestation',
    },
    tests: ROLE_SCOPES[role].map(receiptTest),
    verification: {
      checksumManifestMatched: true,
      candidateAssetHashesMatched: true,
      quarantineReadOnly: true,
      hdiutilVerify: true,
      codesignDeepStrict: true,
    },
  };
  return Object.assign(receipt, overrides);
}

function clone(value) {
  return structuredClone(value);
}

const miniFingerprint = 'a'.repeat(64);
const macBookFingerprint = 'b'.repeat(64);

test('host role fixes the exact per-host scope and option set', () => {
  assert.deepEqual(ROLE_SCOPES['mac-mini'], ['arm64-native']);
  assert.deepEqual(ROLE_SCOPES.macbook, ['arm64-native', 'x64-rosetta']);
  assert.equal(expectedOptionKeys('mac-mini').some((key) => key.startsWith('x64-')), false);
  assert.equal(expectedOptionKeys('macbook').filter((key) => key.startsWith('x64-')).length, 10);
  assert.throws(() => expectedOptionKeys('other'));
});

test('hardware fingerprint is deterministic, domain-separated, and never exposes the identifier', () => {
  const firstId = '11111111-2222-3333-4444-555555555555';
  const secondId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const first = fingerprintHardwareIdentifier(firstId);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, fingerprintHardwareIdentifier(firstId.toUpperCase()));
  assert.notEqual(first, fingerprintHardwareIdentifier(secondId));
  assert.equal(first.includes(firstId), false);
  assert.throws(() => fingerprintHardwareIdentifier('raw-serial-number'));
});

test('host roles are bound to the physical Mac hardware family', () => {
  assert.equal(classifyHardwareFamily('Mac mini'), 'mac-mini');
  assert.equal(classifyHardwareFamily('MacBook Air'), 'macbook');
  assert.equal(classifyHardwareFamily('MacBook Pro'), 'macbook');
  assert.throws(() => classifyHardwareFamily('Mac Studio'));
  const mislabeled = hostReceipt('mac-mini', miniFingerprint);
  mislabeled.host.hardwareFamily = 'macbook';
  assert.throws(() => validateHostReceipt(mislabeled, 'mac-mini', candidate), /hardware family/);
});

test('accepts only the exact credential-free GitHub draft asset URL', () => {
  const url = draftAssets['DesmosLock-mac.dmg'].browserDownloadUrl;
  assert.deepEqual(validateDraftDownloadUrl(url, 'DesmosLock-mac.dmg'), {
    url,
    untaggedToken,
  });
  for (const invalid of [
    url.replace(`/${untaggedToken}/`, `/${TAG}/`),
    url.replace(`/${untaggedToken}/`, '/latest/'),
    `${url}?token=secret`,
    url.replace('https://github.com', 'https://user:secret@github.com'),
    url.replace('github.com/', 'github.com:444/'),
    url.replace('github.com', 'example.com'),
    url.replace('DesmosLock-mac.dmg', 'DesmosLock-mac%2Edmg'),
  ]) assert.throws(() => validateDraftDownloadUrl(invalid, 'DesmosLock-mac.dmg'));
  assert.throws(() => validateDraftDownloadUrl(url, 'DesmosLock-mac.dmg', 'untagged-deadbeef'));
});

test('draft snapshot binds release and asset IDs, sizes, hashes, and one untagged namespace', () => {
  assert.equal(validateDraftReleaseSnapshot(draftRelease, candidate), draftRelease);
  for (const mutate of [
    (snapshot) => { snapshot.releaseId = 0; },
    (snapshot) => { snapshot.repository = 'other/repository'; },
    (snapshot) => { snapshot.tag = 'v1.0.2'; },
    (snapshot) => { snapshot.targetCommitish = 'f'.repeat(40); },
    (snapshot) => { snapshot.draft = false; },
    (snapshot) => { delete snapshot.assets['SHA256SUMS.txt']; },
    (snapshot) => { snapshot.assets['DesmosLock-mac.dmg'].assetId = -1; },
    (snapshot) => { snapshot.assets['DesmosLock-mac.dmg'].size += 1; },
    (snapshot) => { snapshot.assets['DesmosLock-mac.dmg'].sha256 = 'f'.repeat(64); },
    (snapshot) => { snapshot.assets['DesmosLock-mac.dmg'].browserDownloadUrl += '?token=secret'; },
    (snapshot) => {
      snapshot.assets['DesmosLock-mac.dmg'].browserDownloadUrl =
        snapshot.assets['DesmosLock-mac.dmg'].browserDownloadUrl.replace(untaggedToken, 'untagged-deadbeef');
    },
  ]) {
    const changed = structuredClone(draftRelease);
    mutate(changed);
    assert.throws(() => validateDraftReleaseSnapshot(changed, candidate));
  }
});

test('requires truthful macOS draft release disclosures and rejects bypass advice', () => {
  assert.match(validateReleaseNotes(releaseNotes), /^[0-9a-f]{64}$/);
  for (const invalid of [
    '',
    releaseNotes.replace('ad-hoc signed', 'signed'),
    releaseNotes.replace('not notarized', 'notarized'),
    releaseNotes.replace('Open Anyway once', 'Continue once'),
    releaseNotes.replace('Do not remove quarantine or disable Gatekeeper.', 'Run xattr -dr com.apple.quarantine.'),
    `${releaseNotes} Use \`xattr -dr com.apple.quarantine\`.`,
    `${releaseNotes} Run /usr/bin/xattr -dr com.apple.quarantine.`,
    `${releaseNotes} Run spctl --master-disable.`,
  ]) assert.throws(() => validateReleaseNotes(invalid));
});

test('loads a private saved GitHub draft API response into the normalized snapshot', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desmoslock-draft-release-test.'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidateDir = path.join(root, 'candidate');
  const privateDir = path.join(root, 'private');
  fs.mkdirSync(candidateDir);
  fs.mkdirSync(privateDir);
  const snapshotPath = path.join(privateDir, 'draft-release.json');
  fs.writeFileSync(snapshotPath, `${JSON.stringify(rawDraftRelease())}\n`, { mode: 0o600 });
  const loaded = loadDraftReleaseSnapshot(snapshotPath, { ...candidate, candidateDir });
  assert.deepEqual(loaded, draftRelease);

  const bad = rawDraftRelease();
  bad.assets[0].browser_download_url = bad.assets[0].browser_download_url.replace(
    untaggedToken, 'untagged-deadbeef');
  fs.writeFileSync(snapshotPath, `${JSON.stringify(bad)}\n`);
  assert.throws(() => loadDraftReleaseSnapshot(snapshotPath, { ...candidate, candidateDir }));
});

test('rejects malformed GitHub draft API identity and asset evidence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desmoslock-draft-release-invalid.'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidateDir = path.join(root, 'candidate');
  const privateDir = path.join(root, 'private');
  fs.mkdirSync(candidateDir);
  fs.mkdirSync(privateDir);
  const snapshotPath = path.join(privateDir, 'draft-release.json');
  for (const mutate of [
    (raw) => { raw.id = -1; },
    (raw) => { raw.url = raw.url.replace(RELEASE_REPOSITORY, 'other/repository'); },
    (raw) => { raw.tag_name = 'v1.0.2'; },
    (raw) => { raw.target_commitish = 'f'.repeat(40); },
    (raw) => { raw.draft = false; },
    (raw) => { raw.prerelease = true; },
    (raw) => { raw.immutable = true; },
    (raw) => { raw.published_at = '2026-08-13T20:00:00Z'; },
    (raw) => { raw.body = ''; },
    (raw) => { raw.assets.pop(); },
    (raw) => { raw.assets[1].name = raw.assets[0].name; },
    (raw) => { raw.assets[1].id = raw.assets[0].id; },
    (raw) => { raw.assets[0].state = 'new'; },
    (raw) => { raw.assets[0].size += 1; },
    (raw) => { raw.assets[0].digest = `sha256:${'f'.repeat(64)}`; },
    (raw) => { raw.assets[0].url = raw.assets[0].url.replace('/assets/', '/other/'); },
    (raw) => { raw.assets[0].browser_download_url += '#fragment'; },
  ]) {
    const raw = rawDraftRelease();
    mutate(raw);
    fs.writeFileSync(snapshotPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    assert.throws(() => loadDraftReleaseSnapshot(snapshotPath, { ...candidate, candidateDir }));
  }
});

test('witnessed inputs require the expected dialog class, Open Anyway, and relaunch', () => {
  assert.equal(validateObservation('arm64-native', inputObservation(), {
    expectedBrowser: 'Safari',
  }).denialClass, 'unidentified-developer-open-anyway');
  const ordinaryWarning = inputObservation({
    observedMessage: 'macOS cannot verify that this app is free from malware.',
  });
  assert.equal(validateObservation('arm64-native', ordinaryWarning, {
    expectedBrowser: 'Safari',
  }), ordinaryWarning);
  for (const overrides of [
    { freshDownload: 'no' },
    { denialClass: 'damaged' },
    { observedMessage: 'DesmosLock is damaged and should be moved to the Bin.' },
    { damagedObserved: 'yes' },
    { openAnywayLaunched: 'no' },
    { subsequentLaunch: 'no' },
  ]) assert.throws(() => validateObservation('arm64-native', inputObservation(overrides), {
    expectedBrowser: 'Safari',
  }));
});

test('requires the exact ordered checksum contract', () => {
  const manifest = CHECKSUM_FILES.map((filename, index) =>
    `${(index + 1).toString(16).repeat(64)}  ${filename}`).join('\n') + '\n';
  assert.deepEqual(Object.keys(parseChecksumManifest(manifest)), CHECKSUM_FILES);
  assert.throws(() => parseChecksumManifest(manifest.replace(CHECKSUM_FILES[0], 'other.dmg')));
});

test('accepts exact Mini ARM and MacBook ARM plus x64/Rosetta private receipts', () => {
  const mini = hostReceipt('mac-mini', miniFingerprint);
  const macbook = hostReceipt('macbook', macBookFingerprint);
  assert.equal(validateHostReceipt(mini, 'mac-mini', candidate), mini);
  assert.equal(validateHostReceipt(macbook, 'macbook', candidate), macbook);
  assert.deepEqual(validateReceiptPair(mini, macbook, candidate), {
    macMiniReceipt: mini,
    macBookReceipt: macbook,
  });
});

test('rejects wrong role scope, missing Rosetta evidence, and unwitnessed launch claims', () => {
  const wrongScope = hostReceipt('mac-mini', miniFingerprint);
  wrongScope.host.scope.push('x64-rosetta');
  assert.throws(() => validateHostReceipt(wrongScope, 'mac-mini', candidate), /scope/);

  const missingX64 = hostReceipt('macbook', macBookFingerprint);
  missingX64.tests.pop();
  assert.throws(() => validateHostReceipt(missingX64, 'macbook', candidate), /test count/);

  const failedRosetta = hostReceipt('macbook', macBookFingerprint);
  failedRosetta.tests[1].witnessedOperatorAttestation.rosettaLaunched = false;
  assert.throws(() => validateHostReceipt(failedRosetta, 'macbook', candidate), /attestation/);

  const automatedClaim = hostReceipt('mac-mini', miniFingerprint);
  automatedClaim.tests[0].witnessedOperatorAttestation.kind = 'automated-capture';
  assert.throws(() => validateHostReceipt(automatedClaim, 'mac-mini', candidate), /attestation/);
});

test('aggregate contract rejects one physical host reused for both roles', () => {
  const mini = hostReceipt('mac-mini', miniFingerprint);
  const macbook = hostReceipt('macbook', miniFingerprint);
  assert.throws(() => validateReceiptPair(mini, macbook, candidate), /distinct physical hosts/);
});

test('aggregate contract rejects source, release, draft asset, manifest, or hash mismatch', () => {
  const mutations = [
    (receipt) => { receipt.source.commit = 'f'.repeat(40); },
    (receipt) => { receipt.release.tag = 'v1.0.2'; },
    (receipt) => { receipt.candidate.manifestSha256 = 'f'.repeat(64); },
    (receipt) => { receipt.candidate.assetSha256['DesmosLock.AppImage'] = 'f'.repeat(64); },
    (receipt) => { receipt.draftRelease.releaseId += 1; },
    (receipt) => { receipt.draftRelease.assets['DesmosLock-mac.dmg'].assetId += 1; },
  ];
  for (const mutate of mutations) {
    const mini = hostReceipt('mac-mini', miniFingerprint);
    const macbook = clone(hostReceipt('macbook', macBookFingerprint));
    mutate(macbook);
    assert.throws(() => validateReceiptPair(mini, macbook, candidate));
  }
});

test('receipt implementation reads quarantine only and writes private files', () => {
  const recorder = fs.readFileSync(require.resolve('../scripts/record-gatekeeper-acceptance'), 'utf8');
  const aggregate = fs.readFileSync(require.resolve('../scripts/verify-gatekeeper-acceptance'), 'utf8');
  assert.match(recorder, /xattr', \['-p', 'com\.apple\.quarantine'/);
  assert.doesNotMatch(recorder, /xattr[^\n]*(?:'-d'|'-c'|'-w')/);
  assert.match(recorder, /mode: 0o600/);
  assert.match(aggregate, /mode: 0o600/);
});
