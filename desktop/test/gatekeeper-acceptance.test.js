'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { CHECKSUM_FILES, parseChecksumManifest, validateDownloadUrl, validateObservation } =
  require('../scripts/record-gatekeeper-acceptance');

function observation(overrides = {}) {
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

test('accepts only the exact tag-specific credential-free download URL', () => {
  const url = 'https://github.com/desmoslock/desmoslock-releases/releases/download/v1.0.1/DesmosLock-mac.dmg';
  assert.equal(validateDownloadUrl(url, 'DesmosLock-mac.dmg'), url);
  for (const invalid of [
    url.replace('/v1.0.1/', '/latest/'),
    `${url}?token=secret`,
    url.replace('github.com', 'example.com'),
  ]) assert.throws(() => validateDownloadUrl(invalid, 'DesmosLock-mac.dmg'));
});

test('requires unidentified-developer denial, Open Anyway, and a subsequent launch', () => {
  assert.equal(validateObservation('arm64', observation()).denialClass,
    'unidentified-developer-open-anyway');
  for (const overrides of [
    { freshDownload: 'no' },
    { denialClass: 'damaged' },
    { observedMessage: 'DesmosLock is damaged and cannot be opened.' },
    { damagedObserved: 'yes' },
    { openAnywayLaunched: 'no' },
    { subsequentLaunch: 'no' },
  ]) assert.throws(() => validateObservation('arm64', observation(overrides)));
});

test('requires the x64 case to use Chrome and launch under Rosetta', () => {
  const x64 = observation({ browser: 'Chrome', rosettaLaunched: 'yes' });
  assert.equal(validateObservation('x64', x64, { requireRosetta: true }), x64);
  assert.throws(() => validateObservation('x64', { ...x64, rosettaLaunched: 'no' },
    { requireRosetta: true }));
});

test('requires the exact ordered checksum contract', () => {
  const manifest = CHECKSUM_FILES.map((filename, index) =>
    `${String(index).padStart(64, '0')}  ${filename}`).join('\n') + '\n';
  assert.deepEqual(Object.keys(parseChecksumManifest(manifest)), CHECKSUM_FILES);
  assert.throws(() => parseChecksumManifest(manifest.replace(CHECKSUM_FILES[0], 'other.dmg')));
});

test('quarantine inspection is read-only', () => {
  const source = fs.readFileSync(require.resolve('../scripts/record-gatekeeper-acceptance'), 'utf8');
  assert.match(source, /xattr', \['-p', 'com\.apple\.quarantine'/);
  assert.doesNotMatch(source, /xattr[^\n]*(?:'-d'|'-c'|'-w')/);
});
