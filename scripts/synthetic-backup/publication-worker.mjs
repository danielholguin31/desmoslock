import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fsNative, { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_BINDING_STATUS_BYTES = 64;
const MAX_MANIFEST_BYTES = 64 * 1024;
const ROOT_FILE_DESCRIPTOR = 3;
const ROOT_BINDING_CHECK_PATH = "/usr/bin/python3";
const ROOT_BINDING_CHECK_TIMEOUT_MS = 5_000;
const ROOT_BINDING_CHECK = String.raw`
import os, stat, sys

root_path, backup_name = sys.argv[1:3]
root_dev, root_ino, backup_dev, backup_ino = map(int, sys.argv[3:7])
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def matches(observed, expected_dev, expected_ino):
    return observed.st_dev == expected_dev and observed.st_ino == expected_ino

path_root_fd = os.open(root_path, flags)
bound_backup_fd = None
path_backup_fd = None
try:
    path_root = os.fstat(path_root_fd)
    bound_root = os.fstat(3)
    root_path_before = os.stat(root_path, follow_symlinks=False)
    if not all(stat.S_ISDIR(value.st_mode) for value in (path_root, bound_root, root_path_before)):
        raise SystemExit(1)
    if not all(matches(value, root_dev, root_ino) for value in (path_root, bound_root, root_path_before)):
        raise SystemExit(1)

    bound_backup_fd = os.open(backup_name, flags, dir_fd=3)
    path_backup_fd = os.open(backup_name, flags, dir_fd=path_root_fd)
    bound_backup = os.fstat(bound_backup_fd)
    path_backup = os.fstat(path_backup_fd)
    if not all(stat.S_ISDIR(value.st_mode) for value in (bound_backup, path_backup)):
        raise SystemExit(1)
    if not all(matches(value, backup_dev, backup_ino) for value in (bound_backup, path_backup)):
        raise SystemExit(1)

    root_path_after = os.stat(root_path, follow_symlinks=False)
    bound_name_after = os.stat(backup_name, dir_fd=3, follow_symlinks=False)
    path_name_after = os.stat(backup_name, dir_fd=path_root_fd, follow_symlinks=False)
    if not matches(root_path_after, root_dev, root_ino):
        raise SystemExit(1)
    if not all(matches(value, backup_dev, backup_ino) for value in (bound_name_after, path_name_after)):
        raise SystemExit(1)
    os.write(1, b"BOUND_PUBLICATION_VERIFIED\n")
finally:
    if path_backup_fd is not None:
        os.close(path_backup_fd)
    if bound_backup_fd is not None:
        os.close(bound_backup_fd)
    os.close(path_root_fd)
`;

class BoundPublicationError extends Error {
  constructor(code = "BACKUP_WRITE_FAILED") {
    super(code);
    this.code = code;
    this.name = "BoundPublicationError";
  }
}

function fail(code) {
  throw new BoundPublicationError(code);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(stat, identity) {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

function hasExactUniqueStrings(observed, expected) {
  if (!Array.isArray(observed) || observed.length !== expected.length) {
    return false;
  }
  const observedSet = new Set(observed);
  return (
    observedSet.size === observed.length &&
    expected.every((entry) => observedSet.has(entry))
  );
}

async function syncFileDescriptor(fileDescriptor) {
  await new Promise((resolve, reject) => {
    fsNative.fsync(fileDescriptor, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

async function statFileDescriptor(fileDescriptor) {
  return await new Promise((resolve, reject) => {
    fsNative.fstat(fileDescriptor, (error, stat) => {
      if (error === null) resolve(stat);
      else reject(error);
    });
  });
}

async function writeBoundFile(fileName, bytes) {
  let handle;
  let identity;
  let operationError;
  try {
    handle = await fs.open(
      fileName,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail();
    identity = { dev: stat.dev, ino: stat.ino };
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    operationError = error;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      operationError ??= new BoundPublicationError();
    }
  }
  if (operationError !== undefined) throw operationError;
  return identity;
}

async function syncBoundDirectory(identity) {
  let handle;
  let operationError;
  try {
    handle = await fs.open(
      ".",
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isDirectory() || !sameIdentity(stat, identity)) fail();
    await handle.sync();
  } catch (error) {
    operationError = error;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      operationError ??= new BoundPublicationError();
    }
  }
  if (operationError !== undefined) throw operationError;
}

async function assertBoundFile(fileName, identity, expectedLinkCount) {
  const stat = await fs.lstat(fileName);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== expectedLinkCount ||
    !sameIdentity(stat, identity)
  ) {
    fail();
  }
}

async function verifyPublishedBinding(request, backupIdentity) {
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        ROOT_BINDING_CHECK_PATH,
        [
          "-I",
          "-c",
          ROOT_BINDING_CHECK,
          request.rootPath,
          request.backupName,
          String(request.rootIdentity.dev),
          String(request.rootIdentity.ino),
          String(backupIdentity.dev),
          String(backupIdentity.ino),
        ],
        {
          detached: false,
          env: { LANG: "C", LC_ALL: "C" },
          shell: false,
          stdio: ["ignore", "pipe", "pipe", request.rootFileDescriptor],
        },
      );
    } catch {
      reject(new BoundPublicationError());
      return;
    }

    let settled = false;
    let outputBytes = 0;
    let errorBytes = 0;
    const output = [];
    let timer;
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // Stream destruction still keeps the worker boundary bounded.
      }
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new BoundPublicationError());
    };

    child.on("error", abort);
    child.stdout.on("error", abort);
    child.stderr.on("error", abort);
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > MAX_BINDING_STATUS_BYTES) {
        abort();
        return;
      }
      output.push(bytes);
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      errorBytes += Buffer.byteLength(chunk);
      if (errorBytes > MAX_BINDING_STATUS_BYTES) abort();
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (
        code !== 0 ||
        signal !== null ||
        errorBytes !== 0 ||
        Buffer.concat(output).toString("utf8") !==
          "BOUND_PUBLICATION_VERIFIED\n"
      ) {
        abort();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    timer = setTimeout(abort, ROOT_BINDING_CHECK_TIMEOUT_MS);
  });
}

function requestIsValid(request) {
  return (
    Buffer.isBuffer(request?.archive) &&
    request.archive.byteLength > 0 &&
    request.archive.byteLength <= MAX_ARCHIVE_BYTES &&
    typeof request.archiveSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(request.archiveSha256) &&
    request.archiveSha256 === sha256(request.archive) &&
    typeof request.backupName === "string" &&
    /^[a-z0-9][a-z0-9-]{0,63}$/u.test(request.backupName) &&
    Buffer.isBuffer(request.manifest) &&
    request.manifest.byteLength > 0 &&
    request.manifest.byteLength <= MAX_MANIFEST_BYTES &&
    typeof request.manifestSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(request.manifestSha256) &&
    request.manifestSha256 === sha256(request.manifest) &&
    Number.isSafeInteger(request.rootFileDescriptor) &&
    request.rootFileDescriptor >= 0 &&
    Number.isSafeInteger(request.rootIdentity?.dev) &&
    request.rootIdentity.dev >= 0 &&
    Number.isSafeInteger(request.rootIdentity?.ino) &&
    request.rootIdentity.ino > 0 &&
    typeof request.rootPath === "string" &&
    path.isAbsolute(request.rootPath)
  );
}

export async function publishFromBoundRoot(request, hooks = {}) {
  if (!requestIsValid(request)) fail();
  const rootStat = await statFileDescriptor(request.rootFileDescriptor);
  const currentRootStat = await fs.lstat(".");
  if (
    !rootStat.isDirectory() ||
    !currentRootStat.isDirectory() ||
    !sameIdentity(rootStat, request.rootIdentity) ||
    !sameIdentity(currentRootStat, request.rootIdentity)
  ) {
    fail();
  }

  try {
    await fs.mkdir(request.backupName, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") fail("BACKUP_EXISTS");
    throw error;
  }
  const createdDirectoryStat = await fs.lstat(request.backupName);
  if (
    !createdDirectoryStat.isDirectory() ||
    createdDirectoryStat.isSymbolicLink()
  ) {
    fail();
  }
  const backupIdentity = {
    dev: createdDirectoryStat.dev,
    ino: createdDirectoryStat.ino,
  };

  process.chdir(request.backupName);
  const boundDirectoryStat = await fs.lstat(".");
  if (
    !boundDirectoryStat.isDirectory() ||
    !sameIdentity(boundDirectoryStat, backupIdentity)
  ) {
    fail();
  }
  await hooks.afterBackupDirectoryBound?.();

  const archiveIdentity = await writeBoundFile(
    "data.pgcustom",
    request.archive,
  );
  await syncBoundDirectory(backupIdentity);
  await hooks.afterArchiveDurable?.();
  const manifestIdentity = await writeBoundFile(
    "manifest.pending",
    request.manifest,
  );
  await syncBoundDirectory(backupIdentity);
  await hooks.beforeManifestLink?.();
  await fs.link("manifest.pending", "manifest.json");
  await Promise.all([
    assertBoundFile("manifest.pending", manifestIdentity, 2),
    assertBoundFile("manifest.json", manifestIdentity, 2),
  ]);
  await syncBoundDirectory(backupIdentity);
  await hooks.beforeRootSync?.();
  await syncFileDescriptor(request.rootFileDescriptor);

  const entries = await fs.readdir(".");
  if (
    !hasExactUniqueStrings(entries, [
      "data.pgcustom",
      "manifest.json",
      "manifest.pending",
    ])
  ) {
    fail();
  }
  await Promise.all([
    assertBoundFile("data.pgcustom", archiveIdentity, 1),
    assertBoundFile("manifest.pending", manifestIdentity, 2),
    assertBoundFile("manifest.json", manifestIdentity, 2),
  ]);
  const finalRootStat = await statFileDescriptor(request.rootFileDescriptor);
  if (!sameIdentity(finalRootStat, request.rootIdentity)) fail();

  await verifyPublishedBinding(request, backupIdentity);
}

async function readExactInput(expectedBytes) {
  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    receivedBytes += bytes.byteLength;
    if (receivedBytes > expectedBytes) fail();
    chunks.push(bytes);
  }
  if (receivedBytes !== expectedBytes) fail();
  return Buffer.concat(chunks, receivedBytes);
}

function parseInteger(value, minimum, maximum) {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) fail();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail();
  }
  return parsed;
}

async function writeStatus(status) {
  await new Promise((resolve) => {
    process.stdout.write(`${status}\n`, resolve);
  });
}

async function runCommandLine() {
  const [
    marker,
    backupName,
    rootPath,
    rootDevice,
    rootInode,
    archiveLength,
    archiveSha256,
    manifestLength,
    manifestSha256,
  ] = process.argv.slice(2);
  if (
    process.argv.length !== 11 ||
    marker !== "--publish-from-bound-root" ||
    typeof archiveSha256 !== "string" ||
    typeof manifestSha256 !== "string"
  ) {
    fail();
  }
  const parsedArchiveLength = parseInteger(archiveLength, 1, MAX_ARCHIVE_BYTES);
  const parsedManifestLength = parseInteger(
    manifestLength,
    1,
    MAX_MANIFEST_BYTES,
  );
  const payload = await readExactInput(
    parsedArchiveLength + parsedManifestLength,
  );
  await publishFromBoundRoot({
    archive: payload.subarray(0, parsedArchiveLength),
    archiveSha256,
    backupName,
    manifest: payload.subarray(parsedArchiveLength),
    manifestSha256,
    rootFileDescriptor: ROOT_FILE_DESCRIPTOR,
    rootIdentity: {
      dev: parseInteger(rootDevice, 0, Number.MAX_SAFE_INTEGER),
      ino: parseInteger(rootInode, 1, Number.MAX_SAFE_INTEGER),
    },
    rootPath,
  });
  await writeStatus("BACKUP_PUBLISHED");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runCommandLine();
  } catch (error) {
    await writeStatus(
      error instanceof BoundPublicationError && error.code === "BACKUP_EXISTS"
        ? "BACKUP_EXISTS"
        : "BACKUP_WRITE_FAILED",
    );
  }
}
