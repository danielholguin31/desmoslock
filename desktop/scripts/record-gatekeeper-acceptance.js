'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateRepository, validateSha } = require('./provenance-contract');

const RELEASE_REPOSITORY = 'desmoslock/desmoslock-releases';
const TAG = 'v1.0.1';
const EXPECTED_FILES = [
  'DesmosLock-mac.dmg',
  'DesmosLock-mac-intel.dmg',
  'DesmosLock-setup.exe',
  'DesmosLock.AppImage',
  'RELEASE-PROVENANCE.json',
  'SHA256SUMS.txt',
];
const CHECKSUM_FILES = EXPECTED_FILES.filter((name) => name !== 'SHA256SUMS.txt');

function fail(message) {
  throw new Error(message);
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

function requireExactKeys(values, expected) {
  const actual = Object.keys(values).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`options must be exactly: ${wanted.map((key) => `--${key}`).join(', ')}`);
  }
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function requireRegularFile(file, label) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular, non-symlink file`);
  return info;
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

function validateDownloadUrl(value, filename) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${filename} download URL is invalid`);
  }
  const expectedPath = `/${RELEASE_REPOSITORY}/releases/download/${TAG}/${filename}`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' ||
      url.pathname !== expectedPath || url.username || url.password || url.search || url.hash) {
    fail(`${filename} must use its credential-free, tag-specific GitHub release URL`);
  }
  return url.toString();
}

function validateObservation(label, observation, { requireRosetta = false } = {}) {
  if (observation.browser !== (label === 'arm64' ? 'Safari' : 'Chrome')) {
    fail(`${label} must be freshly downloaded with ${label === 'arm64' ? 'Safari' : 'Chrome'}`);
  }
  if (observation.freshDownload !== 'yes') fail(`${label} must attest a fresh browser download`);
  if (observation.denialClass !== 'unidentified-developer-open-anyway') {
    fail(`${label} denial class must be unidentified-developer-open-anyway`);
  }
  if (typeof observation.observedMessage !== 'string' ||
      observation.observedMessage.length < 5 || observation.observedMessage.length > 500 ||
      /[\r\n]/.test(observation.observedMessage)) {
    fail(`${label} observed message must be one nonempty line of at most 500 characters`);
  }
  if (/damaged/i.test(observation.observedMessage) || observation.damagedObserved !== 'no') {
    fail(`${label} displayed a damaged-app classification`);
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

function requireQuarantine(file, label) {
  const result = spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    fail(`${label} is missing browser quarantine metadata`);
  }
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

function main(argv) {
  if (process.platform !== 'darwin') fail('Gatekeeper acceptance must run on macOS');
  const options = parseArgs(argv);
  requireExactKeys(options, [
    'candidate-dir', 'arm64-dmg', 'arm64-browser', 'arm64-url',
    'arm64-fresh-download', 'arm64-denial-class', 'arm64-observed-message',
    'arm64-damaged-observed', 'arm64-open-anyway-launched', 'arm64-subsequent-launch',
    'x64-dmg', 'x64-browser', 'x64-url', 'x64-fresh-download', 'x64-denial-class',
    'x64-observed-message', 'x64-damaged-observed', 'x64-open-anyway-launched',
    'x64-subsequent-launch', 'x64-rosetta-launched', 'physical-intel-status', 'output',
  ]);

  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'RELEASES_REPO_TOKEN']) {
    if (process.env[name] !== undefined) fail(`${name} must not be present during acceptance recording`);
  }

  const candidateDir = fs.realpathSync(options['candidate-dir']);
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

  const hostArchitecture = commandOutput('/usr/bin/uname', ['-m']);
  if (hostArchitecture !== 'arm64') fail('x64/Rosetta acceptance must run on an Apple-silicon Mac');
  const rosettaProbe = spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true']);
  if (rosettaProbe.status !== 0) fail('Rosetta is unavailable for the required x64 launch test');
  if (!['unavailable', 'passed-separately'].includes(options['physical-intel-status'])) {
    fail('--physical-intel-status must be unavailable or passed-separately');
  }

  const assets = [
    {
      key: 'arm64', filename: 'DesmosLock-mac.dmg', architecture: 'arm64',
      path: fs.realpathSync(options['arm64-dmg']), browser: options['arm64-browser'],
      url: options['arm64-url'], freshDownload: options['arm64-fresh-download'],
      denialClass: options['arm64-denial-class'], observedMessage: options['arm64-observed-message'],
      damagedObserved: options['arm64-damaged-observed'],
      openAnywayLaunched: options['arm64-open-anyway-launched'],
      subsequentLaunch: options['arm64-subsequent-launch'], executionMode: 'native',
    },
    {
      key: 'x64', filename: 'DesmosLock-mac-intel.dmg', architecture: 'x86_64',
      path: fs.realpathSync(options['x64-dmg']), browser: options['x64-browser'],
      url: options['x64-url'], freshDownload: options['x64-fresh-download'],
      denialClass: options['x64-denial-class'], observedMessage: options['x64-observed-message'],
      damagedObserved: options['x64-damaged-observed'],
      openAnywayLaunched: options['x64-open-anyway-launched'],
      subsequentLaunch: options['x64-subsequent-launch'],
      rosettaLaunched: options['x64-rosetta-launched'], executionMode: 'rosetta',
    },
  ];

  for (const asset of assets) {
    requireRegularFile(asset.path, `${asset.key} browser download`);
    if (path.basename(asset.path) !== asset.filename) fail(`${asset.key} download filename is not stable`);
    if (sameFile(asset.path, path.join(candidateDir, asset.filename))) {
      fail(`${asset.key} test input is the assembled file, not a separate browser download`);
    }
    asset.url = validateDownloadUrl(asset.url, asset.filename);
    validateObservation(asset.key, asset, { requireRosetta: asset.key === 'x64' });
    requireQuarantine(asset.path, asset.key);
    if (hashFile(asset.path) !== checksums[asset.filename] ||
        provenance?.assets?.[asset.filename]?.sha256 !== checksums[asset.filename]) {
      fail(`${asset.key} browser download does not match the accepted final DMG`);
    }
    verifyDmg(asset.path, asset.architecture);
  }
  if (sameFile(assets[0].path, assets[1].path)) fail('arm64 and x64 tests must use separate downloads');

  const output = path.resolve(options.output);
  if (fs.existsSync(output)) fail('receipt output must not already exist');
  if (!fs.statSync(path.dirname(output)).isDirectory()) fail('receipt output parent must exist');
  if (output.startsWith(`${candidateDir}${path.sep}`)) fail('receipt must remain outside the six-asset directory');

  const receipt = {
    schemaVersion: 1,
    recordedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: { repository: sourceRepository, commit: sourceSha },
    release: { repository: RELEASE_REPOSITORY, tag: TAG },
    candidate: { manifestSha256: hashFile(manifestPath) },
    host: {
      macosProductVersion: commandOutput('/usr/bin/sw_vers', ['-productVersion']),
      macosBuildVersion: commandOutput('/usr/bin/sw_vers', ['-buildVersion']),
      architecture: hostArchitecture,
      physicalIntelStatus: options['physical-intel-status'],
    },
    policy: {
      passingDenialClass: 'unidentified-developer-open-anyway',
      spctlAcceptanceExpected: false,
      quarantineRemovalUsed: false,
      receiptIsPublicReleaseAsset: false,
    },
    tests: assets.map((asset) => ({
      filename: asset.filename,
      sha256: checksums[asset.filename],
      browser: asset.browser,
      downloadUrl: asset.url,
      freshBrowserDownload: true,
      quarantinePresent: true,
      architecture: asset.architecture,
      executionMode: asset.executionMode,
      denialClass: asset.denialClass,
      observedMessage: asset.observedMessage,
      damagedMessageObserved: false,
      openAnywayLaunched: true,
      subsequentLaunchWorked: true,
    })),
    verification: {
      checksumManifestMatched: true,
      hdiutilVerify: true,
      codesignDeepStrict: true,
    },
  };
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  process.stdout.write(`PASS: Gatekeeper acceptance receipt written to ${output}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { CHECKSUM_FILES, parseChecksumManifest, validateDownloadUrl, validateObservation };
