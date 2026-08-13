'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  EXPECTED_FILES,
  hashFile,
  loadCandidate,
  parseArgs,
  pathIsInside,
  resolveRegularFile,
  resolveNewPrivateOutput,
  sameFile,
  validateReceiptPair,
} = require('./record-gatekeeper-acceptance');

function fail(message) {
  throw new Error(message);
}

function loadPrivateReceipt(receiptArgument, candidateDir, label) {
  const receiptPath = resolveRegularFile(receiptArgument, label);
  const info = fs.lstatSync(receiptPath);
  if ((info.mode & 0o077) !== 0) fail(`${label} must not be readable or writable by group/others`);
  if (pathIsInside(candidateDir, receiptPath)) fail(`${label} must remain outside the six-asset directory`);
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return { receiptPath, receipt };
}

function main(argv) {
  const options = parseArgs(argv);
  const expectedKeys = ['candidate-dir', 'mac-mini-receipt', 'macbook-receipt', 'output'];
  if (JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(expectedKeys.sort())) {
    fail('options must be exactly --candidate-dir, --mac-mini-receipt, --macbook-receipt, and --output');
  }
  for (const name of [
    'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
    'RELEASES_REPO_TOKEN', 'RELEASES_REPO_READ_TOKEN',
  ]) {
    if (process.env[name] !== undefined) fail(`${name} must not be present during aggregate verification`);
  }

  const candidate = loadCandidate(options['candidate-dir']);
  const mini = loadPrivateReceipt(options['mac-mini-receipt'], candidate.candidateDir, 'Mac Mini receipt');
  const macbook = loadPrivateReceipt(options['macbook-receipt'], candidate.candidateDir, 'MacBook receipt');
  if (sameFile(mini.receiptPath, macbook.receiptPath)) fail('host receipt inputs must be distinct files');
  validateReceiptPair(mini.receipt, macbook.receipt, candidate);

  const output = resolveNewPrivateOutput(options.output, candidate.candidateDir, 'aggregate receipt');
  if (sameFile(path.dirname(output), path.dirname(mini.receiptPath)) &&
      path.basename(output) === path.basename(mini.receiptPath)) fail('aggregate output collides with Mac Mini receipt');
  if (sameFile(path.dirname(output), path.dirname(macbook.receiptPath)) &&
      path.basename(output) === path.basename(macbook.receiptPath)) fail('aggregate output collides with MacBook receipt');

  const aggregate = {
    schemaVersion: 1,
    receiptType: 'gatekeeper-two-host-acceptance',
    verifiedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: candidate.source,
    release: candidate.release,
    candidate: {
      manifestSha256: candidate.manifestSha256,
      assetSha256: candidate.assetSha256,
    },
    requirements: {
      exactPublicAssetCount: EXPECTED_FILES.length,
      exactRoles: ['mac-mini', 'macbook'],
      macMiniScope: ['arm64-native'],
      macBookScope: ['arm64-native', 'x64-rosetta'],
      distinctPhysicalHosts: true,
      witnessedOperatorAttestationsRequired: true,
      receiptIsPublicReleaseAsset: false,
    },
    hosts: [mini, macbook].map(({ receiptPath, receipt }) => ({
      role: receipt.host.role,
      scope: receipt.host.scope,
      fingerprintSha256: receipt.host.fingerprintSha256,
      hostReceiptSha256: hashFile(receiptPath),
      hostReceiptRecordedAtUtc: receipt.recordedAtUtc,
    })),
    verification: {
      liveSixAssetCandidateMatched: true,
      sourceRepositoryAndCommitMatched: true,
      releaseRepositoryAndTagMatched: true,
      manifestAndEveryAssetHashMatched: true,
      exactRoleScopesMatched: true,
      distinctHostFingerprintsMatched: true,
      macMiniArm64NativeAccepted: true,
      macBookArm64NativeAccepted: true,
      macBookX64RosettaAccepted: true,
    },
  };
  fs.writeFileSync(output, `${JSON.stringify(aggregate, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`PASS: private two-host Gatekeeper acceptance receipt written to ${output}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}
