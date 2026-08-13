'use strict';

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NODE_VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const UTC_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function fail(label, value) {
  throw new Error(`${label} is ${value}`);
}

function validateRepository(value, label = 'repository') {
  if (typeof value !== 'string' || !REPOSITORY_PATTERN.test(value)) fail(label, value);
  const [owner, repository] = value.split('/');
  if (owner.endsWith('-') || repository === '.' || repository === '..') fail(label, value);
  return value;
}

function parseGitHubRepositoryRemote(remote) {
  if (typeof remote !== 'string' || remote.trim() !== remote || remote.length === 0) {
    fail('GitHub origin URL', remote);
  }

  let owner;
  let repository;
  let match = remote.match(/^git@github\.com:([^/]+)\/([^/]+)$/);
  if (match) {
    [, owner, repository] = match;
  } else {
    match = remote.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/);
    if (match) {
      [, owner, repository] = match;
    } else {
      let parsed;
      try {
        parsed = new URL(remote);
      } catch {
        fail('GitHub origin URL', remote);
      }
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' ||
          parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash ||
          /%/.test(parsed.pathname) || !/^\/[^/]+\/[^/]+$/.test(parsed.pathname)) {
        fail('GitHub origin URL', remote);
      }
      [, owner, repository] = parsed.pathname.split('/');
    }
  }

  repository = repository.replace(/\.git$/, '');
  return validateRepository(`${owner}/${repository}`, 'GitHub origin repository');
}

function validateSha(value, label = 'source SHA') {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) fail(label, value);
  return value;
}

function validatePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(label, value);
  return value;
}

function validateUtcSeconds(value, label = 'UTC timestamp') {
  if (typeof value !== 'string' || !UTC_SECONDS_PATTERN.test(value)) fail(label, value);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value.replace('Z', '.000Z')) {
    fail(label, value);
  }
  return value;
}

function validateReleaseVersion(value, label, options = {}) {
  if (typeof value !== 'string' || !RELEASE_VERSION_PATTERN.test(value)) fail(label, value);
  if (options.major != null && Number(value.split('.')[0]) !== options.major) fail(label, value);
  if (options.exact != null && value !== options.exact) fail(label, value);
  return value;
}

function validateNodeVersion(value, label = 'nodeVersion', options = {}) {
  if (typeof value !== 'string' || !NODE_VERSION_PATTERN.test(value)) fail(label, value);
  if (options.major != null && Number(value.slice(1).split('.')[0]) !== options.major) fail(label, value);
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label, value);
  return value;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) fail(label, actual);
}

function validateRunner(runner, platform) {
  requireObject(runner, 'runner');
  const expected = platform === 'windows'
    ? { environment: 'github-hosted', os: 'Windows', arch: 'X64', requestedLabel: 'windows-latest' }
    : { environment: 'github-hosted', os: 'Linux', arch: 'X64', requestedLabel: 'ubuntu-latest' };
  for (const [field, value] of Object.entries(expected)) {
    requireEqual(runner[field], value, `runner.${field}`);
  }
  return runner;
}

function validateHostedBuildMetadata(metadata, expected) {
  requireObject(metadata, 'hosted build metadata');
  requireEqual(metadata.schemaVersion, 1, 'schemaVersion');
  requireEqual(validateRepository(metadata.sourceRepository, 'sourceRepository'), expected.sourceRepository, 'sourceRepository');
  requireEqual(validatePositiveInteger(metadata.sourceRepositoryId, 'sourceRepositoryId'), Number(expected.sourceRepositoryId), 'sourceRepositoryId');
  requireEqual(validateRepository(metadata.workflowRepository, 'workflowRepository'), expected.sourceRepository, 'workflowRepository');
  requireEqual(validatePositiveInteger(metadata.workflowRepositoryId, 'workflowRepositoryId'), Number(expected.sourceRepositoryId), 'workflowRepositoryId');
  requireEqual(validateSha(metadata.sourceSha), expected.sourceSha, 'sourceSha');
  requireEqual(metadata.version, '1.0.1', 'version');
  requireEqual(metadata.platform, expected.platform, 'platform');
  requireEqual(metadata.targetArchitecture, 'x64', 'targetArchitecture');
  requireEqual(String(validatePositiveInteger(metadata.workflowRunId, 'workflowRunId')), String(expected.runId), 'workflowRunId');
  requireEqual(String(validatePositiveInteger(metadata.workflowRunAttempt, 'workflowRunAttempt')), String(expected.runAttempt), 'workflowRunAttempt');
  validateUtcSeconds(metadata.builtAtUtc, 'builtAtUtc');
  validateNodeVersion(metadata.nodeVersion, 'nodeVersion', { major: 22 });
  validateReleaseVersion(metadata.npmVersion, 'npmVersion', { exact: '10.9.9' });
  validateReleaseVersion(metadata.electronBuilderVersion, 'electronBuilderVersion', {
    exact: expected.electronBuilderVersion,
  });
  validateRunner(metadata.runner, expected.platform);
  return metadata;
}

function validateMacBuilder(builder) {
  requireObject(builder, 'builder');
  requireObject(builder.os, 'builder.os');
  requireEqual(builder.os.name, 'macOS', 'builder.os.name');
  if (typeof builder.os.productVersion !== 'string' ||
      !/^\d+(?:\.\d+){1,2}$/.test(builder.os.productVersion)) {
    fail('builder.os.productVersion', builder.os.productVersion);
  }
  if (typeof builder.os.buildVersion !== 'string' ||
      !/^[0-9A-Za-z]+$/.test(builder.os.buildVersion)) {
    fail('builder.os.buildVersion', builder.os.buildVersion);
  }
  if (builder.architecture !== 'arm64' && builder.architecture !== 'x86_64') {
    fail('builder.architecture', builder.architecture);
  }

  const tools = requireObject(builder.developerTools, 'builder.developerTools');
  if (tools.kind !== 'command-line-tools' && tools.kind !== 'xcode') {
    fail('builder.developerTools.kind', tools.kind);
  }
  if (typeof tools.version !== 'string' || !/^\d+(?:\.\d+)+$/.test(tools.version)) {
    fail('builder.developerTools.version', tools.version);
  }
  if (tools.kind === 'command-line-tools' &&
      tools.selectedDirectory !== '/Library/Developer/CommandLineTools') {
    fail('builder.developerTools.selectedDirectory', tools.selectedDirectory);
  }
  if (tools.kind === 'xcode' &&
      (typeof tools.selectedDirectory !== 'string' ||
       !/^\/[^\n]+\.app\/Contents\/Developer$/.test(tools.selectedDirectory))) {
    fail('builder.developerTools.selectedDirectory', tools.selectedDirectory);
  }
  if (typeof tools.macosSdkVersion !== 'string' ||
      !/^\d+(?:\.\d+){1,3}$/.test(tools.macosSdkVersion)) {
    fail('builder.developerTools.macosSdkVersion', tools.macosSdkVersion);
  }
  if (typeof tools.appleClangVersion !== 'string' ||
      !/^Apple clang version [^\n]+$/.test(tools.appleClangVersion)) {
    fail('builder.developerTools.appleClangVersion', tools.appleClangVersion);
  }
  requireEqual(tools.codesignPath, '/usr/bin/codesign', 'builder.developerTools.codesignPath');
  return builder;
}

function validateMacBuildMetadataCore(metadata, expected) {
  requireObject(metadata, 'macOS build metadata');
  requireEqual(metadata.schemaVersion, 1, 'schemaVersion');
  requireEqual(validateRepository(metadata.sourceRepository, 'sourceRepository'), expected.sourceRepository, 'sourceRepository');
  requireEqual(validateSha(metadata.sourceSha), expected.sourceSha, 'sourceSha');
  requireEqual(metadata.trustedBranch, expected.trustedBranch, 'trustedBranch');
  requireEqual(metadata.version, '1.0.1', 'version');
  requireEqual(metadata.platform, 'macos', 'platform');
  requireEqual(metadata.targetArchitecture, 'arm64+x64', 'targetArchitecture');
  requireEqual(metadata.signing, 'ad-hoc', 'signing');
  requireEqual(metadata.notarized, false, 'notarized');
  requireEqual(metadata.hardenedRuntime, true, 'hardenedRuntime');
  validateUtcSeconds(metadata.builtAtUtc, 'builtAtUtc');
  validateNodeVersion(metadata.nodeVersion, 'nodeVersion', { major: 22 });
  validateReleaseVersion(metadata.npmVersion, 'npmVersion', { exact: '10.9.9' });
  validateReleaseVersion(metadata.electronBuilderVersion, 'electronBuilderVersion', {
    exact: expected.electronBuilderVersion,
  });
  validateMacBuilder(metadata.builder);
  return metadata;
}

function hostedProvenanceFields(metadata) {
  return {
    builtAtUtc: metadata.builtAtUtc,
    nodeVersion: metadata.nodeVersion,
    npmVersion: metadata.npmVersion,
    electronBuilderVersion: metadata.electronBuilderVersion,
    runner: {
      environment: metadata.runner.environment,
      os: metadata.runner.os,
      arch: metadata.runner.arch,
      requestedLabel: metadata.runner.requestedLabel,
    },
  };
}

module.exports = {
  hostedProvenanceFields,
  parseGitHubRepositoryRemote,
  validateHostedBuildMetadata,
  validateMacBuildMetadataCore,
  validateNodeVersion,
  validatePositiveInteger,
  validateReleaseVersion,
  validateRepository,
  validateSha,
  validateUtcSeconds,
};
