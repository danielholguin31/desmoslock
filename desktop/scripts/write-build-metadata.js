'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  parseGitHubRepositoryRemote,
  validateHostedBuildMetadata,
} = require('./provenance-contract');

function requiredEnvironment(name, pattern) {
  const value = process.env[name] || '';
  if (!pattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function oneFile(directory, predicate, description) {
  const matches = fs.readdirSync(directory)
    .filter(predicate)
    .map((name) => path.join(directory, name));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${description}; found ${matches.length}`);
  }
  return matches[0];
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function asset(file, targetArchitecture) {
  return {
    fileName: path.basename(file),
    targetArchitecture,
    bytes: fs.statSync(file).size,
    sha256: sha256(file),
  };
}

function commandOutput(command, args, options = {}) {
  return childProcess.execFileSync(command, args, {
    encoding: 'utf8',
    ...options,
  }).trim();
}

function peMachine(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const dosHeader = Buffer.alloc(64);
    if (fs.readSync(descriptor, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) {
      throw new Error(`truncated DOS header: ${file}`);
    }
    if (dosHeader.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error(`missing MZ header: ${file}`);
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    if (fs.readSync(descriptor, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) {
      throw new Error(`truncated PE header: ${file}`);
    }
    if (!peHeader.subarray(0, 4).equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))) {
      throw new Error(`missing PE signature: ${file}`);
    }
    return `0x${peHeader.readUInt16LE(4).toString(16).padStart(4, '0')}`;
  } finally {
    fs.closeSync(descriptor);
  }
}

function extractFromInstaller(installer, archivePath) {
  const sevenZip = require('7zip-bin').path7za;
  const test = childProcess.spawnSync(sevenZip, ['t', installer], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (test.status !== 0) {
    throw new Error(`NSIS archive test failed with status ${test.status}`);
  }
  const extraction = childProcess.spawnSync(sevenZip, ['x', '-so', installer, archivePath], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (extraction.status !== 0 || !Buffer.isBuffer(extraction.stdout) || extraction.stdout.length === 0) {
    throw new Error(`could not extract ${archivePath} from the NSIS installer`);
  }
  return extraction.stdout;
}

const sourceSha = requiredEnvironment('SOURCE_SHA', /^[0-9a-f]{40}$/);
const sourceRepository = requiredEnvironment(
  'SOURCE_REPOSITORY',
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
);
const sourceRepositoryId = requiredEnvironment('SOURCE_REPOSITORY_ID', /^[1-9][0-9]*$/);
const workflowRepository = requiredEnvironment(
  'GITHUB_REPOSITORY',
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
);
const workflowRepositoryId = requiredEnvironment('GITHUB_REPOSITORY_ID', /^[1-9][0-9]*$/);
const platform = requiredEnvironment('BUILD_PLATFORM', /^(windows|linux)$/);
const workflowRunId = requiredEnvironment('GITHUB_RUN_ID', /^[1-9][0-9]*$/);
const workflowRunAttempt = requiredEnvironment('GITHUB_RUN_ATTEMPT', /^[1-9][0-9]*$/);
const runnerEnvironment = requiredEnvironment('RUNNER_ENVIRONMENT', /^github-hosted$/);
const runnerOs = requiredEnvironment('RUNNER_OS', /^(Windows|Linux)$/);
const runnerArch = requiredEnvironment('RUNNER_ARCH', /^X64$/);
const runnerRequestedLabel = requiredEnvironment(
  'RUNNER_REQUESTED_LABEL',
  /^(windows-latest|ubuntu-latest)$/,
);
const packagePath = path.join(__dirname, '..', 'package.json');
const version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
const outputDirectory = path.join(__dirname, '..', 'dist');
const repositoryRoot = path.join(__dirname, '..', '..');
const electronBuilderPackage = path.join(
  __dirname,
  '..',
  'node_modules',
  'electron-builder',
  'package.json',
);
const packageLockPath = path.join(__dirname, '..', 'package-lock.json');

if (version !== '1.0.1') {
  throw new Error(`recovery metadata requires version 1.0.1; found ${version}`);
}
if (sourceRepository !== workflowRepository || sourceRepositoryId !== workflowRepositoryId) {
  throw new Error('supplied source repository identity does not match the workflow repository');
}
if (commandOutput('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD']) !== sourceSha) {
  throw new Error('checked-out HEAD does not match SOURCE_SHA');
}
const originRepository = parseGitHubRepositoryRemote(
  commandOutput('git', ['-C', repositoryRoot, 'remote', 'get-url', 'origin']),
);
if (originRepository !== sourceRepository) {
  throw new Error(`origin repository is ${originRepository}, expected ${sourceRepository}`);
}

const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmVersion = commandOutput(npmExecutable, ['--version'], {
  shell: process.platform === 'win32',
});
const electronBuilderVersion = JSON.parse(
  fs.readFileSync(electronBuilderPackage, 'utf8'),
).version;
const lockedElectronBuilderVersion = JSON.parse(
  fs.readFileSync(packageLockPath, 'utf8'),
).packages['node_modules/electron-builder'].version;
if (electronBuilderVersion !== lockedElectronBuilderVersion) {
  throw new Error(
    `installed electron-builder ${electronBuilderVersion} does not match locked ${lockedElectronBuilderVersion}`,
  );
}

const metadata = {
  schemaVersion: 1,
  sourceSha,
  sourceRepository,
  sourceRepositoryId: Number(sourceRepositoryId),
  workflowRepository,
  workflowRepositoryId: Number(workflowRepositoryId),
  version,
  platform,
  workflowRunId: Number(workflowRunId),
  workflowRunAttempt: Number(workflowRunAttempt),
  builtAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  nodeVersion: process.version,
  npmVersion,
  electronBuilderVersion,
  runner: {
    environment: runnerEnvironment,
    os: runnerOs,
    arch: runnerArch,
    requestedLabel: runnerRequestedLabel,
  },
};

if (platform === 'windows') {
  const installer = oneFile(outputDirectory, (name) => name.endsWith('.exe'), 'Windows installer');
  const payload = path.join(outputDirectory, 'win-unpacked', 'DesmosLock.exe');
  const applicationArchive = path.join(outputDirectory, 'win-unpacked', 'resources', 'app.asar');
  if (!fs.statSync(payload).isFile()) throw new Error(`Windows payload is missing: ${payload}`);
  if (!fs.statSync(applicationArchive).isFile()) {
    throw new Error(`Windows application archive is missing: ${applicationArchive}`);
  }
  metadata.targetArchitecture = 'x64';
  metadata.payloadMachine = peMachine(payload);
  metadata.wrapperMachine = peMachine(installer);
  if (metadata.payloadMachine !== '0x8664') {
    throw new Error(`Windows payload machine must be AMD64 0x8664; found ${metadata.payloadMachine}`);
  }
  if (metadata.wrapperMachine !== '0x014c') {
    throw new Error(`NSIS wrapper machine must be i386 0x014c; found ${metadata.wrapperMachine}`);
  }
  const embeddedApplicationArchive = extractFromInstaller(installer, 'resources/app.asar');
  const unpackedApplicationArchive = fs.readFileSync(applicationArchive);
  if (!embeddedApplicationArchive.equals(unpackedApplicationArchive)) {
    throw new Error('NSIS resources/app.asar differs from win-unpacked/resources/app.asar');
  }
  metadata.payload = asset(payload, 'x64');
  metadata.applicationArchive = asset(applicationArchive, 'platform-neutral');
  metadata.artifact = asset(installer, 'x64');
} else {
  const installer = oneFile(outputDirectory, (name) => name.endsWith('.AppImage'), 'Linux AppImage');
  metadata.targetArchitecture = 'x64';
  metadata.artifact = asset(installer, 'x64');
}

validateHostedBuildMetadata(metadata, {
  sourceSha,
  sourceRepository,
  sourceRepositoryId: Number(sourceRepositoryId),
  platform,
  runId: workflowRunId,
  runAttempt: workflowRunAttempt,
  electronBuilderVersion,
});

fs.writeFileSync(
  path.join(outputDirectory, 'BUILD-METADATA.json'),
  `${JSON.stringify(metadata, null, 2)}\n`,
  { flag: 'wx', mode: 0o644 },
);
