'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  hostedProvenanceFields,
  parseGitHubRepositoryRemote,
  validateHostedBuildMetadata,
  validateMacBuildMetadataCore,
  validateUtcSeconds,
} = require('../scripts/provenance-contract');

const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const sourceRepository = 'danielholguin31/desmoslock';
const sourceRepositoryId = 1326190305;
const electronBuilderVersion = '25.1.8';
const pinnedPackageManager = 'npm@10.9.9+sha512.d60fba8cb42f688b81e33c2f1cbef2ad7b977166700ec0ad057f1b6d60ea6ef2524abf673e20c35931cd8305d1dbb8887134d6eefdc0e7b8435bd458bf65b862';

test('pins the local npm runtime by version and tarball hash', () => {
  assert.equal(require('../package.json').packageManager, pinnedPackageManager);
});

test('regenerates the committed vendor bundle only on the canonical Linux builder', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/release.yml'),
    'utf8',
  );
  const windowsStart = workflow.indexOf('\n  build-windows:');
  const linuxStart = workflow.indexOf('\n  build-linux:');
  assert.ok(windowsStart > 0 && linuxStart > windowsStart, 'hosted build jobs are missing');
  const windowsJob = workflow.slice(windowsStart, linuxStart);
  const linuxJob = workflow.slice(linuxStart);

  assert.match(windowsJob, /needs: \[trusted-source, build-linux\]/);
  assert.match(windowsJob,
    /needs\.trusted-source\.result == 'success' && needs\.build-linux\.result == 'success'/);
  assert.doesNotMatch(windowsJob, /npm run build:vendor/);
  assert.match(windowsJob, /Use the exact committed browser dependency bundle/);
  assert.match(windowsJob, /git diff --quiet --exit-code -- desktop\/renderer\/vendor\/supabase\.js/);
  assert.equal((linuxJob.match(/npm run build:vendor/g) || []).length, 1);
  assert.match(linuxJob, /canonical vendor rebuild changed tracked, staged, or untracked source/);
});

function hostedMetadata(platform = 'windows') {
  const windows = platform === 'windows';
  return {
    schemaVersion: 1,
    sourceSha,
    sourceRepository,
    sourceRepositoryId,
    workflowRepository: sourceRepository,
    workflowRepositoryId: sourceRepositoryId,
    version: '1.0.1',
    platform,
    targetArchitecture: 'x64',
    workflowRunId: 1234,
    workflowRunAttempt: 2,
    builtAtUtc: '2026-08-13T12:34:56Z',
    nodeVersion: 'v22.22.2',
    npmVersion: '10.9.9',
    electronBuilderVersion,
    runner: {
      environment: 'github-hosted',
      os: windows ? 'Windows' : 'Linux',
      arch: 'X64',
      requestedLabel: windows ? 'windows-latest' : 'ubuntu-latest',
    },
  };
}

function hostedExpected(platform = 'windows') {
  return {
    sourceSha,
    sourceRepository,
    sourceRepositoryId,
    platform,
    runId: '1234',
    runAttempt: '2',
    electronBuilderVersion,
  };
}

function macMetadata() {
  return {
    schemaVersion: 1,
    sourceRepository,
    sourceSha,
    trustedBranch: 'release/1.0',
    version: '1.0.1',
    platform: 'macos',
    targetArchitecture: 'arm64+x64',
    signing: 'ad-hoc',
    notarized: false,
    hardenedRuntime: true,
    builtAtUtc: '2026-08-13T12:34:56Z',
    nodeVersion: 'v22.22.2',
    npmVersion: '10.9.9',
    electronBuilderVersion,
    builder: {
      os: { name: 'macOS', productVersion: '26.3', buildVersion: '25D125' },
      architecture: 'arm64',
      developerTools: {
        kind: 'command-line-tools',
        version: '26.4.1.0.1775747724',
        selectedDirectory: '/Library/Developer/CommandLineTools',
        macosSdkVersion: '26.4.1',
        appleClangVersion: 'Apple clang version 21.0.0 (clang-2100.0.123.102)',
        codesignPath: '/usr/bin/codesign',
      },
    },
  };
}

test('normalizes supported GitHub origin URL formats', () => {
  for (const remote of [
    'https://github.com/danielholguin31/desmoslock.git',
    'git@github.com:danielholguin31/desmoslock.git',
    'ssh://git@github.com/danielholguin31/desmoslock.git',
  ]) {
    assert.equal(parseGitHubRepositoryRemote(remote), sourceRepository);
  }
});

test('rejects redirects, credentials, alternate hosts, and ambiguous origin paths', () => {
  for (const remote of [
    'https://token@github.com/danielholguin31/desmoslock.git',
    'https://example.com/danielholguin31/desmoslock.git',
    'https://github.com/danielholguin31/desmoslock.git/extra',
    'https://github.com//danielholguin31/desmoslock.git',
    'https://github.com/danielholguin31//desmoslock.git',
    'https://github.com/danielholguin31/desmoslock.git/',
    'git://github.com/danielholguin31/desmoslock.git',
  ]) {
    assert.throws(() => parseGitHubRepositoryRemote(remote));
  }
});

test('accepts the explicit actual identity after a future repository transfer', () => {
  const transferredRepository = 'desmoslock/desmoslock';
  const hosted = hostedMetadata('linux');
  hosted.sourceRepository = transferredRepository;
  hosted.workflowRepository = transferredRepository;
  assert.equal(validateHostedBuildMetadata(hosted, {
    ...hostedExpected('linux'),
    sourceRepository: transferredRepository,
  }), hosted);

  const mac = macMetadata();
  mac.sourceRepository = transferredRepository;
  mac.trustedBranch = 'main';
  assert.equal(validateMacBuildMetadataCore(mac, {
    sourceSha,
    sourceRepository: transferredRepository,
    trustedBranch: 'main',
    electronBuilderVersion,
  }), mac);
});

test('accepts exact all-platform hosted provenance and copies tool fields verbatim', () => {
  for (const platform of ['windows', 'linux']) {
    const metadata = hostedMetadata(platform);
    assert.equal(validateHostedBuildMetadata(metadata, hostedExpected(platform)), metadata);
    assert.deepEqual(hostedProvenanceFields(metadata), {
      builtAtUtc: metadata.builtAtUtc,
      nodeVersion: metadata.nodeVersion,
      npmVersion: metadata.npmVersion,
      electronBuilderVersion: metadata.electronBuilderVersion,
      runner: metadata.runner,
    });
  }
});

test('rejects missing or malformed hosted build time and tool versions', () => {
  for (const [field, value] of [
    ['builtAtUtc', undefined],
    ['builtAtUtc', '2026-02-30T12:34:56Z'],
    ['builtAtUtc', '2026-08-13T12:34:56.123Z'],
    ['nodeVersion', 'v20.20.0'],
    ['npmVersion', '10.9.8'],
    ['electronBuilderVersion', '25.1.7'],
  ]) {
    const metadata = hostedMetadata();
    metadata[field] = value;
    assert.throws(() => validateHostedBuildMetadata(metadata, hostedExpected()), new RegExp(field));
  }
});

test('rejects mismatched actual source and workflow identity', () => {
  for (const [field, value] of [
    ['sourceRepository', 'desmoslock/desmoslock'],
    ['sourceRepositoryId', 1],
    ['workflowRepository', 'desmoslock/desmoslock'],
    ['workflowRepositoryId', 1],
  ]) {
    const metadata = hostedMetadata();
    metadata[field] = value;
    assert.throws(() => validateHostedBuildMetadata(metadata, hostedExpected()), new RegExp(field));
  }
});

test('rejects untrusted hosted runner attributes', () => {
  for (const [field, value] of [
    ['environment', 'self-hosted'],
    ['os', 'macOS'],
    ['arch', 'ARM64'],
    ['requestedLabel', 'ubuntu-24.04'],
  ]) {
    const metadata = hostedMetadata();
    metadata.runner[field] = value;
    assert.throws(() => validateHostedBuildMetadata(metadata, hostedExpected()), new RegExp(field));
  }
});

test('accepts exact macOS source and builder/tool provenance', () => {
  const metadata = macMetadata();
  assert.equal(validateMacBuildMetadataCore(metadata, {
    sourceSha,
    sourceRepository,
    trustedBranch: 'release/1.0',
    electronBuilderVersion,
  }), metadata);
});

test('accepts the two-component SDK version reported by full Xcode', () => {
  const metadata = macMetadata();
  metadata.builder.developerTools = {
    ...metadata.builder.developerTools,
    kind: 'xcode',
    version: '16.4',
    selectedDirectory: '/Applications/Xcode.app/Contents/Developer',
    macosSdkVersion: '15.5',
  };
  assert.equal(validateMacBuildMetadataCore(metadata, {
    sourceSha,
    sourceRepository,
    trustedBranch: 'release/1.0',
    electronBuilderVersion,
  }), metadata);
});

test('rejects false macOS source identity and malformed builder/tool provenance', () => {
  const cases = [
    (metadata) => { metadata.sourceRepository = 'desmoslock/desmoslock'; },
    (metadata) => { metadata.trustedBranch = 'main'; },
    (metadata) => { metadata.nodeVersion = 'v20.20.0'; },
    (metadata) => { metadata.npmVersion = '10.9.8'; },
    (metadata) => { metadata.npmVersion = '11.6.2'; },
    (metadata) => { metadata.builder.os.buildVersion = ''; },
    (metadata) => { metadata.builder.architecture = 'X64'; },
    (metadata) => { metadata.builder.developerTools.version = ''; },
    (metadata) => { metadata.builder.developerTools.codesignPath = '/tmp/codesign'; },
  ];
  for (const mutate of cases) {
    const metadata = macMetadata();
    mutate(metadata);
    assert.throws(() => validateMacBuildMetadataCore(metadata, {
      sourceSha,
      sourceRepository,
      trustedBranch: 'release/1.0',
      electronBuilderVersion,
    }));
  }
});

test('UTC timestamps require a real second-precision instant', () => {
  assert.equal(validateUtcSeconds('2024-02-29T23:59:59Z'), '2024-02-29T23:59:59Z');
  for (const timestamp of [
    '2023-02-29T23:59:59Z',
    '2026-13-01T00:00:00Z',
    '2026-08-13T12:34:56+00:00',
  ]) {
    assert.throws(() => validateUtcSeconds(timestamp));
  }
});
