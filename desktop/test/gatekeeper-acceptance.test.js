'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
  CHECKSUM_FILES,
  EXPECTED_FILES,
  RELEASE_REPOSITORY,
  ROLE_SCOPES,
  TAG,
  classifyHardwareFamily,
  expectedOptionKeys,
  fingerprintHardwareIdentifier,
  parseChecksumManifest,
  validateDownloadUrl,
  validateHostReceipt,
  validateObservation,
  validateReceiptPair,
} = require('../scripts/record-gatekeeper-acceptance');

const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const sourceRepository = 'danielholguin31/desmoslock';
const hashes = Object.fromEntries(EXPECTED_FILES.map((filename, index) => [
  filename,
  (index + 1).toString(16).repeat(64),
]));
const candidate = {
  source: { repository: sourceRepository, commit: sourceSha },
  release: { repository: RELEASE_REPOSITORY, tag: TAG },
  manifestSha256: hashes['SHA256SUMS.txt'],
  assetSha256: hashes,
};

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
    canonicalDownloadUrl: `https://github.com/${RELEASE_REPOSITORY}/releases/download/${TAG}/${filename}`,
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
    schemaVersion: 2,
    receiptType: 'gatekeeper-host-acceptance',
    recordedAtUtc: '2026-08-13T19:45:00Z',
    source: { ...candidate.source },
    release: { ...candidate.release },
    candidate: {
      manifestSha256: candidate.manifestSha256,
      assetSha256: { ...candidate.assetSha256 },
    },
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

test('accepts only the canonical tag-specific URL with no embedded credential', () => {
  const url = `https://github.com/${RELEASE_REPOSITORY}/releases/download/${TAG}/DesmosLock-mac.dmg`;
  assert.equal(validateDownloadUrl(url, 'DesmosLock-mac.dmg'), url);
  for (const invalid of [
    url.replace(`/${TAG}/`, '/latest/'),
    `${url}?token=secret`,
    url.replace('https://github.com', 'https://user:secret@github.com'),
    url.replace('github.com', 'example.com'),
  ]) assert.throws(() => validateDownloadUrl(invalid, 'DesmosLock-mac.dmg'));
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

test('aggregate contract rejects any source, tag, manifest, or six-asset hash mismatch', () => {
  const mutations = [
    (receipt) => { receipt.source.commit = 'f'.repeat(40); },
    (receipt) => { receipt.release.tag = 'v1.0.2'; },
    (receipt) => { receipt.candidate.manifestSha256 = 'f'.repeat(64); },
    (receipt) => { receipt.candidate.assetSha256['DesmosLock.AppImage'] = 'f'.repeat(64); },
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
