import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import plist from "plist";
import { getCurrentFuseWire } from "@electron/fuses";
import { packager } from "@electron/packager";
import {
  extractFile,
  getRawHeader,
  listPackage,
  statFile,
  uncache,
} from "@electron/asar";
import { parseClientBuildIdentity } from "../packages/contracts/dist/build-identity.js";
import {
  hardenPackagedElectron,
  verifyPackagedElectronFuses,
} from "./electron-fuse-policy.mjs";

export const nativeDistributionFiles = Object.freeze([
  "native/aac-protection.node",
  "native/durable-record.node",
]);
export const packagedExecutableName = "desmoslock-internal";
const appName = "DesmosLock Internal";
const standaloneCrashpadPath =
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler";
const signedStatFormat = "%N\t%Op\t%Ul\t%Uu\t%Ug\t%Uf\t%Ud\t%Ui";

// Signing accepts a controlled transformation, never signature-free Mach-O
// equivalence. These closed observers do not invoke a signer or grant authority.
const signedObjectKeys = [
  "objectPath",
  "primaryPath",
  "parentPath",
  "role",
  "identifier",
  "requirement",
  "entitlements",
  "runtime",
  "signatureFiles",
  "signatureDirectories",
];
const signedSnapshotKeys = [
  "schemaVersion",
  "kind",
  "buildIdentity",
  "tree",
  "machOFiles",
  "metadata",
  "fuseWires",
  "asarIntegrity",
];
const signedLimit = Object.freeze({
  entries: 12000,
  objects: 40,
  batch: 64,
  argumentBytes: 16384,
  outputBytes: 65536,
  attributeBytes: 4096,
  attributeNames: 8,
  commands: 1400,
});

function signedPath(value, root = false) {
  if (root && value === ".") return value;
  assert.equal(typeof value, "string");
  assert.ok(
    value.length > 0 &&
      value.length <= 1000 &&
      /^[A-Za-z0-9@_ .()+/-]+$/.test(value) &&
      value
        .split("/")
        .every(
          (part) =>
            part &&
            part !== "." &&
            part !== ".." &&
            part.trim() === part &&
            !part.toLowerCase().startsWith(".env") &&
            !/^(?:\.git|\.ssh|\.aws|\.gnupg|\.config|keychains?|credentials?(?:\..*)?|secrets?(?:\..*)?|auth-cache)$/i.test(
              part,
            ),
        ),
    "Invalid signed artifact entry path",
  );
  return value;
}

function signedRows(value, maximum, label) {
  assert.ok(
    Array.isArray(value) && value.length <= maximum,
    `${label} exceeds its limit`,
  );
  return exactRows(value, value.length, label);
}

function nonnegativeInteger(value) {
  assert.ok(
    Number.isSafeInteger(value) && value >= 0,
    "Invalid metadata integer",
  );
  return value;
}

function signedMetadataPolicy(value) {
  const row = exactObservation(
    value,
    ["ownerUid", "ownerGid", "allowedXattrs", "copySymlinkMtime"],
    "Signed metadata policy",
  );
  nonnegativeInteger(row.ownerUid);
  nonnegativeInteger(row.ownerGid);
  assert.equal(row.copySymlinkMtime, "record-destination");
  const allowedXattrs = signedRows(
    row.allowedXattrs,
    signedLimit.entries * 2,
    "Allowed xattrs",
  ).map((value) => {
    const item = exactObservation(
      value,
      ["path", "name", "bytes", "sha256"],
      "Allowed xattr",
    );
    signedPath(item.path, true);
    assert.ok(
      ["com.apple.quarantine", "com.apple.provenance"].includes(item.name),
      "Unsupported signing xattr policy",
    );
    nonnegativeInteger(item.bytes);
    assert.ok(item.bytes <= signedLimit.attributeBytes);
    sha256(item.sha256);
    return item;
  });
  const keys = allowedXattrs.map((row) => `${row.path}:${row.name}`);
  assert.deepEqual(
    keys,
    [...new Set(keys)].sort(),
    "Xattr policy must be unique and sorted",
  );
  return { ...row, allowedXattrs };
}

function signedRequirement(team, identifier) {
  return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}" and identifier "${identifier}"`;
}

function signedPolicy(value) {
  const policy = exactObservation(
    value,
    ["schemaVersion", "kind", "teamId", "objects", "metadata"],
    "Signing policy",
  );
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.kind, "signed-artifact-policy");
  assert.match(policy.teamId, /^[A-Z0-9]{10}$/);
  const objects = signedRows(
    policy.objects,
    signedLimit.objects,
    "Signing objects",
  ).map((value) => {
    const row = exactObservation(value, signedObjectKeys, "Signing object");
    signedPath(row.objectPath, true);
    signedPath(row.primaryPath);
    if (row.parentPath !== null) signedPath(row.parentPath, true);
    assert.ok(
      ["main", "helper", "framework", "library", "addon"].includes(row.role),
    );
    assert.match(row.identifier, /^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$/);
    assert.equal(
      row.requirement,
      signedRequirement(policy.teamId, row.identifier),
      "Signing requirement differs from approved Team and identifier",
    );
    assert.equal(typeof row.runtime, "boolean");
    const entitlements = exactObservation(
      row.entitlements,
      Object.keys(row.entitlements),
      "Entitlements",
    );
    assert.ok(JSON.stringify(entitlements).length <= 8192);
    for (const [key, val] of Object.entries(entitlements)) {
      assert.match(key, /^[A-Za-z0-9.-]{1,200}$/);
      assert.ok(
        typeof val === "boolean" ||
          (typeof val === "string" && /^[A-Za-z0-9._-]{1,200}$/.test(val)) ||
          (Array.isArray(val) &&
            signedRows(val, 32, "Entitlement strings").every(
              (entry) =>
                typeof entry === "string" &&
                /^[A-Za-z0-9._-]{1,200}$/.test(entry),
            )),
        "Unsupported entitlement value",
      );
    }
    let signatureDirectory;
    if (row.role === "main") {
      assert.equal(row.objectPath, ".");
      assert.equal(row.primaryPath, `Contents/MacOS/${packagedExecutableName}`);
      assert.equal(row.parentPath, null);
      assert.equal(row.runtime, true);
      signatureDirectory = "Contents/_CodeSignature";
    } else if (row.role === "helper") {
      assert.equal(row.runtime, true);
      if (row.objectPath === standaloneCrashpadPath) {
        assert.equal(row.primaryPath, standaloneCrashpadPath);
      } else {
        assert.ok(row.objectPath.endsWith(".app"));
        assert.equal(
          path.posix.dirname(row.primaryPath),
          `${row.objectPath}/Contents/MacOS`,
        );
        signatureDirectory = `${row.objectPath}/Contents/_CodeSignature`;
      }
    } else if (row.role === "framework") {
      assert.ok(row.objectPath.endsWith(".framework"));
      assert.equal(
        path.posix.dirname(row.primaryPath),
        `${row.objectPath}/Versions/A`,
      );
      signatureDirectory = `${row.objectPath}/Versions/A/_CodeSignature`;
    } else {
      assert.equal(row.objectPath, row.primaryPath);
      assert.ok(
        row.role === "addon"
          ? row.primaryPath.endsWith(".node")
          : row.primaryPath.endsWith(".dylib"),
      );
    }
    if (!["main", "helper"].includes(row.role))
      assert.deepEqual(entitlements, {}, "Library entitlements must be absent");
    assert.deepEqual(
      row.signatureDirectories,
      signatureDirectory ? [signatureDirectory] : [],
    );
    assert.deepEqual(
      row.signatureFiles,
      signatureDirectory ? [`${signatureDirectory}/CodeResources`] : [],
    );
    return { ...row, entitlements };
  });
  assert.ok(objects.length > 0);
  assert.equal(
    new Set(objects.map((row) => row.objectPath)).size,
    objects.length,
    "Duplicate signing object",
  );
  assert.equal(
    new Set(objects.map((row) => row.primaryPath)).size,
    objects.length,
    "Duplicate signing primary",
  );
  assert.equal(objects.filter((row) => row.role === "main").length, 1);
  for (const object of objects.filter((row) => row.role !== "main")) {
    const parents = objects
      .filter(
        (parent) =>
          parent.objectPath !== object.objectPath &&
          ["main", "helper", "framework"].includes(parent.role) &&
          parent.objectPath !== parent.primaryPath &&
          (parent.objectPath === "." ||
            object.objectPath.startsWith(`${parent.objectPath}/`)),
      )
      .sort((a, b) => b.objectPath.length - a.objectPath.length);
    assert.equal(
      object.parentPath,
      parents[0]?.objectPath,
      "Signing parent is not the containing code object",
    );
  }
  return {
    ...policy,
    objects,
    metadata: signedMetadataPolicy(policy.metadata),
  };
}

function insideOut(objects) {
  const depth = (row) =>
    row.objectPath === "." ? 0 : row.objectPath.split("/").length;
  return [...objects].sort(
    (a, b) =>
      depth(b) - depth(a) ||
      (a.objectPath < b.objectPath ? -1 : a.objectPath > b.objectPath ? 1 : 0),
  );
}

export function deriveSignedArtifactPlan({
  unsignedInventory,
  policy,
  signingSteps,
}) {
  policy = signedPolicy(policy);
  assert.equal(unsignedInventory.kind, "unsigned-universal-app-inventory");
  assert.equal(unsignedInventory.schemaVersion, 1);
  selectedUniversalIdentity(unsignedInventory.buildIdentity);
  const tree = unsignedInventory.tree;
  assert.equal(
    digest(JSON.stringify(tree.entries)),
    sha256(tree.sha256),
    "Accepted unsigned tree digest disagrees",
  );
  const entries = signedRows(
    tree.entries,
    signedLimit.entries,
    "Unsigned entries",
  );
  for (const entry of entries) signedPath(entry.path);
  assert.deepEqual(
    entries.map((row) => row.path),
    [...new Set(entries.map((row) => row.path))].sort(),
  );
  const files = signedRows(
    unsignedInventory.composition.machOFiles,
    signedLimit.objects,
    "Unsigned Mach-O inventory",
  );
  assert.deepEqual(
    files.map((row) => row.path).sort(),
    policy.objects.map((row) => row.primaryPath).sort(),
    "Code policy does not account for every Mach-O",
  );
  for (const object of policy.objects) {
    const entry = entries.find((row) => row.path === object.primaryPath);
    const file = files.find((row) => row.path === object.primaryPath);
    assert.equal(entry?.type, "file");
    assert.equal(entry.sha256, file.sha256);
    assert.equal(entry.bytes, file.bytes);
    assert.deepEqual(Object.keys(file.slices).sort(), ["arm64", "x64"]);
    retainedUniversalMachO(file, object.primaryPath);
    if (object.objectPath !== object.primaryPath && object.objectPath !== ".")
      assert.equal(
        entries.find((row) => row.path === object.objectPath)?.type,
        "directory",
        "Signing object cannot be a symlink alias",
      );
  }
  for (const entry of entries) {
    if (entry.type === "file" && (entry.mode & 0o111) !== 0)
      assert.ok(
        files.some((row) => row.path === entry.path),
        "Unclassified executable file",
      );
    if (entry.path.split("/").includes("_CodeSignature"))
      assert.ok(
        policy.objects.some(
          (row) =>
            row.signatureFiles.includes(entry.path) ||
            row.signatureDirectories.includes(entry.path),
        ),
        "Undeclared signature resource",
      );
  }
  const ordered = insideOut(policy.objects);
  assert.deepEqual(
    signingSteps,
    ordered,
    "Signing schedule is not the fixed inside-out object sequence",
  );
  const knownPaths = [".", ...entries.map((row) => row.path)];
  for (const attribute of policy.metadata.allowedXattrs)
    assert.ok(
      knownPaths.includes(attribute.path),
      "Metadata policy names an absent unsigned entry",
    );
  // Reserve against the largest admitted root name, including the closed paths
  // that signing may create. Exact-root observation repeats this before calls.
  signedMetadataCommandPlan(
    `/${"a".repeat(1000)}`,
    [
      ...new Set([
        ...knownPaths,
        ...policy.objects.flatMap((row) => [
          ...row.signatureFiles,
          ...row.signatureDirectories,
        ]),
      ]),
    ].sort(),
    policy.metadata.allowedXattrs,
  );
  const result = {
    schemaVersion: 1,
    kind: "signed-artifact-plan",
    unsignedTreeSha256: tree.sha256,
    policySha256: digest(`${JSON.stringify(policy)}\n`),
    objects: policy.objects,
    signingSteps: ordered,
  };
  const plan = JSON.parse(
    JSON.stringify({
      ...result,
      sha256: digest(`${JSON.stringify(result)}\n`),
    }),
  );
  function freeze(value) {
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) freeze(item);
      Object.freeze(value);
    }
    return value;
  }
  return freeze(plan);
}

async function signedTree(root) {
  assert.ok(path.isAbsolute(root) && root === path.resolve(root));
  signedPath(root.slice(1));
  await assertDirectory(root);
  const entries = [];
  const statuses = new Map();
  async function visit(relative) {
    const filename = path.join(root, relative === "." ? "" : relative);
    const status = await fs.lstat(filename, { bigint: true });
    statuses.set(relative, status);
    assert.ok(
      statuses.size <= signedLimit.entries,
      "Signed tree entry limit exceeded",
    );
    const mode = Number(status.mode & 0o777n);
    if (status.isDirectory()) {
      if (relative !== ".")
        entries.push({ path: relative, type: "directory", mode });
      for (const name of (await fs.readdir(filename)).sort()) {
        signedPath(name);
        await visit(relative === "." ? name : `${relative}/${name}`);
      }
    } else if (status.isSymbolicLink()) {
      const target = await fs.readlink(filename);
      signedPath(target);
      await validateContainedLink(root, relative);
      entries.push({ path: relative, type: "symlink", mode, target });
    } else {
      assert.ok(
        status.isFile() && status.nlink === 1n,
        "Signed tree requires ordinary single-link files",
      );
      assert.ok(
        status.size <= 2n * 1024n ** 3n,
        "Signed tree file exceeds bound",
      );
      entries.push({
        path: relative,
        type: "file",
        mode,
        ...(await measureRegularFile(filename)),
      });
    }
    sameFile(status, await fs.lstat(filename, { bigint: true }));
  }
  await visit(".");
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    tree: { entries, sha256: digest(JSON.stringify(entries)) },
    statuses,
  };
}

function signedBatches(values, extra = []) {
  const batches = [];
  let batch = [];
  let bytes = extra.reduce(
    (sum, value) => sum + Buffer.byteLength(value) + 1,
    0,
  );
  for (const value of values) {
    const size = Buffer.byteLength(value) + 1;
    assert.ok(size + 1024 < signedLimit.argumentBytes);
    if (
      batch.length >= signedLimit.batch ||
      bytes + size > signedLimit.argumentBytes - 1024
    ) {
      batches.push(batch);
      batch = [];
      bytes = extra.reduce(
        (sum, value) => sum + Buffer.byteLength(value) + 1,
        0,
      );
    }
    batch.push(value);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function signedMetadataCommandPlan(root, relativePaths, attributes) {
  assert.ok(
    relativePaths.length <= signedLimit.entries,
    "Metadata entry capacity exceeded",
  );
  const names = relativePaths.map((relative) =>
    path.join(root, relative === "." ? "" : relative),
  );
  const batches = signedBatches(names, ["-f", signedStatFormat]);
  const namesToAttributes = new Map(names.map((name) => [name, new Set()]));
  for (const attribute of attributes) {
    const name = path.join(root, attribute.path === "." ? "" : attribute.path);
    assert.ok(
      namesToAttributes.has(name),
      "Metadata policy path missing from planned inventory",
    );
    namesToAttributes.get(name).add(attribute.name);
  }
  const commandCount = batches.reduce(
    (count, batch) =>
      count +
      3 +
      new Set(batch.flatMap((name) => [...namesToAttributes.get(name)])).size,
    0,
  );
  assert.ok(
    commandCount <= signedLimit.commands,
    "Metadata command capacity exhausted before observation",
  );
  return { batches, commandCount };
}

async function signedMetadata(root, tree, statuses, policy, runCommand) {
  assert.equal(
    typeof runCommand,
    "function",
    "Metadata requires the pinned tracked command owner",
  );
  const expected = signedMetadataPolicy(policy);
  const relativePaths = [".", ...tree.entries.map((row) => row.path)].sort();
  const commandPlan = signedMetadataCommandPlan(
    root,
    relativePaths,
    expected.allowedXattrs,
  );
  const records = new Map();
  let commandCount = 0;
  async function run(toolId, args) {
    assert.ok(
      ++commandCount <= commandPlan.commandCount,
      "Metadata command budget exhausted",
    );
    assert.ok(
      args.reduce((sum, value) => sum + Buffer.byteLength(value) + 1, 0) <=
        signedLimit.argumentBytes,
    );
    const result = exactObservation(
      await runCommand(toolId, args),
      ["stdout", "stderr", "exitCode"],
      "Metadata command result",
    );
    assert.equal(result.exitCode, 0, "Metadata command failed");
    assert.equal(result.stderr, "", "Metadata command emitted diagnostics");
    assert.equal(typeof result.stdout, "string");
    assert.ok(
      Buffer.byteLength(result.stdout) <= signedLimit.outputBytes,
      "Metadata output exceeds bound",
    );
    assert.ok(!result.stdout.includes("\r") && !result.stdout.includes("\0"));
    return result.stdout;
  }
  for (const names of commandPlan.batches) {
    const output = await run("stat", ["-f", signedStatFormat, ...names]);
    assert.ok(output.endsWith("\n"));
    const lines = output.slice(0, -1).split("\n");
    assert.equal(
      lines.length,
      names.length,
      "Stat batch attribution is incomplete",
    );
    for (let index = 0; index < lines.length; index++) {
      const fields = lines[index].split("\t");
      assert.equal(fields.length, 8);
      assert.equal(fields[0], names[index], "Stat batch path mismatch");
      assert.match(fields[1], /^[0-7]{5,6}$/);
      for (const field of fields.slice(2))
        assert.match(field, /^(?:0|[1-9][0-9]*)$/);
      const relative =
        names[index] === root
          ? "."
          : path.relative(root, names[index]).split(path.sep).join("/");
      const observed = statuses.get(relative);
      const mode = BigInt(`0o${fields[1]}`);
      assert.equal(mode, observed.mode);
      assert.equal(BigInt(fields[2]), observed.nlink);
      assert.equal(BigInt(fields[3]), observed.uid);
      assert.equal(BigInt(fields[4]), observed.gid);
      assert.equal(BigInt(fields[6]), observed.dev);
      assert.equal(BigInt(fields[7]), observed.ino);
      assert.equal(
        Number(mode & 0o7000n),
        0,
        "Special mode bits are forbidden",
      );
      assert.equal(fields[5], "0", "File flags are forbidden");
      assert.equal(
        Number(observed.uid),
        expected.ownerUid,
        "Unexpected artifact owner",
      );
      assert.equal(
        Number(observed.gid),
        expected.ownerGid,
        "Unexpected artifact group",
      );
      records.set(names[index], {
        path: relative,
        type: observed.isDirectory()
          ? "directory"
          : observed.isSymbolicLink()
            ? "symlink"
            : "file",
        mode: Number(mode),
        uid: Number(observed.uid),
        gid: Number(observed.gid),
        links: Number(observed.nlink),
        flags: 0,
        mtimeNs: String(observed.mtimeNs),
        ctimeNs: String(observed.ctimeNs),
        device: String(observed.dev),
        inode: String(observed.ino),
        xattrs: [],
      });
    }
    const acl = await run("ls", ["-l", "-n", "-e", "-d", "-P", ...names]);
    assert.ok(acl.endsWith("\n"));
    const aclLines = acl.slice(0, -1).split("\n");
    assert.equal(
      aclLines.length,
      names.length,
      "ACL entries or incomplete ACL batch",
    );
    for (let index = 0; index < aclLines.length; index++) {
      const row = records.get(names[index]);
      const entry = tree.entries.find((entry) => entry.path === row.path);
      const suffix = `${names[index]}${row.type === "symlink" ? ` -> ${entry.target}` : ""}`;
      assert.ok(aclLines[index].endsWith(suffix), "ACL batch path mismatch");
      const prefix = aclLines[index].slice(0, -suffix.length);
      assert.match(
        prefix,
        /^[dl-][rwxStTs-]{9}[@ ]?\s+[0-9]+\s+[0-9]+\s+[0-9]+\s+[0-9]+\s+[A-Z][a-z]{2}\s+[0-9]{1,2}\s+(?:[0-9]{2}:[0-9]{2}|[0-9]{4})\s+$/,
        "Unsupported ACL listing or ACL marker",
      );
    }
    const attrNames = await run("xattr", ["-s", "-v", ...names]);
    const groups = new Map();
    assert.ok(
      attrNames === "" || attrNames.endsWith("\n"),
      "Incomplete xattr names output",
    );
    for (const line of attrNames === ""
      ? []
      : attrNames.slice(0, -1).split("\n")) {
      const fields = line.split(": ");
      assert.equal(fields.length, 2);
      assert.ok(names.includes(fields[0]), "Foreign xattr batch path");
      assert.ok(
        ["com.apple.quarantine", "com.apple.provenance"].includes(fields[1]),
        "Forbidden or unknown xattr",
      );
      const group = groups.get(fields[1]) ?? [];
      assert.ok(!group.includes(fields[0]), "Duplicate xattr observation");
      group.push(fields[0]);
      groups.set(fields[1], group);
    }
    for (const [name, targets] of [...groups.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const hex = await run("xattr", [
        "-s",
        "-p",
        "-x",
        "-v",
        name,
        ...targets,
      ]);
      assert.ok(hex.endsWith("\n"));
      const values = new Map();
      let current = null;
      for (const line of hex.slice(0, -1).split("\n")) {
        if (line.endsWith(": ")) {
          current = line.slice(0, -2);
          assert.ok(
            targets.includes(current) && !values.has(current),
            "Foreign or duplicate xattr value path",
          );
          values.set(current, "");
        } else {
          assert.ok(current !== null);
          assert.match(line, /^(?:[0-9A-F]{2} ?)*$/, "Malformed xattr hex");
          const value = values.get(current) + line.replaceAll(" ", "");
          assert.ok(
            value.length <= signedLimit.attributeBytes * 2,
            "Xattr value exceeds bound",
          );
          values.set(current, value);
        }
      }
      assert.deepEqual(
        [...values.keys()],
        targets,
        "Xattr value batch attribution incomplete",
      );
      for (const [target, hexValue] of values) {
        const bytes = Buffer.from(hexValue, "hex");
        records
          .get(target)
          .xattrs.push({ name, bytes: bytes.length, sha256: digest(bytes) });
      }
    }
  }
  const entries = [...records.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const actualAttributes = entries.flatMap((row) =>
    row.xattrs.map((attribute) => ({ path: row.path, ...attribute })),
  );
  assert.deepEqual(
    actualAttributes,
    expected.allowedXattrs,
    "Artifact xattrs differ from approved input metadata",
  );
  assert.equal(
    commandCount,
    commandPlan.commandCount,
    "Metadata calls differ from reserved capacity",
  );
  for (const [relative, before] of statuses)
    sameFile(
      before,
      await fs.lstat(path.join(root, relative === "." ? "" : relative), {
        bigint: true,
      }),
    );
  return {
    schemaVersion: 1,
    entries,
    commandCount,
    singleFileFallbackCount: 0,
    sha256: digest(`${JSON.stringify(entries)}\n`),
  };
}

function signedSnapshot(value) {
  const snapshot = exactObservation(
    value,
    signedSnapshotKeys,
    "Signed custody observation",
  );
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.kind, "signed-artifact-custody");
  selectedUniversalIdentity(snapshot.buildIdentity);
  const tree = exactObservation(
    snapshot.tree,
    ["entries", "sha256"],
    "Custody tree",
  );
  assert.equal(digest(JSON.stringify(tree.entries)), sha256(tree.sha256));
  const paths = signedRows(
    tree.entries,
    signedLimit.entries,
    "Custody entries",
  ).map((row) => signedPath(row.path));
  assert.deepEqual(paths, [...new Set(paths)].sort());
  for (const row of tree.entries) {
    exactObservation(
      row,
      row.type === "file"
        ? ["path", "type", "mode", "sha256", "bytes"]
        : row.type === "symlink"
          ? ["path", "type", "mode", "target"]
          : ["path", "type", "mode"],
      "Custody entry",
    );
    assert.ok(["file", "directory", "symlink"].includes(row.type));
    assert.ok(Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o777);
    if (row.type === "file") {
      sha256(row.sha256);
      nonnegativeInteger(row.bytes);
    }
    if (row.type === "symlink") signedPath(row.target);
  }
  const metadata = exactObservation(
    snapshot.metadata,
    [
      "schemaVersion",
      "entries",
      "commandCount",
      "singleFileFallbackCount",
      "sha256",
    ],
    "Custody metadata",
  );
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(
    metadata.sha256,
    digest(`${JSON.stringify(metadata.entries)}\n`),
  );
  assert.deepEqual(
    metadata.entries.map((row) => row.path),
    [".", ...paths].sort(),
  );
  for (const row of metadata.entries) {
    exactObservation(
      row,
      [
        "path",
        "type",
        "mode",
        "uid",
        "gid",
        "links",
        "flags",
        "mtimeNs",
        "ctimeNs",
        "device",
        "inode",
        "xattrs",
      ],
      "Custody metadata entry",
    );
    const entry =
      row.path === "."
        ? { type: "directory", mode: row.mode & 0o777 }
        : tree.entries.find((entry) => entry.path === row.path);
    assert.equal(row.type, entry.type);
    assert.equal(row.mode & 0o777, entry.mode);
    assert.equal(row.mode & 0o7000, 0);
    for (const field of ["mode", "uid", "gid", "links"])
      nonnegativeInteger(row[field]);
    assert.equal(row.flags, 0);
    if (row.type === "file") assert.equal(row.links, 1);
    for (const key of ["mtimeNs", "ctimeNs", "device", "inode"])
      assert.match(row[key], /^(?:0|[1-9][0-9]*)$/);
    const names = signedRows(
      row.xattrs,
      signedLimit.attributeNames,
      "Custody xattrs",
    ).map((attribute) => {
      exactObservation(attribute, ["name", "bytes", "sha256"], "Custody xattr");
      assert.ok(
        ["com.apple.quarantine", "com.apple.provenance"].includes(
          attribute.name,
        ),
      );
      nonnegativeInteger(attribute.bytes);
      assert.ok(attribute.bytes <= signedLimit.attributeBytes);
      sha256(attribute.sha256);
      return attribute.name;
    });
    assert.deepEqual(names, [...new Set(names)].sort());
  }
  nonnegativeInteger(metadata.commandCount);
  assert.ok(metadata.commandCount <= signedLimit.commands);
  assert.equal(metadata.singleFileFallbackCount, 0);
  const machOFiles = signedRows(
    snapshot.machOFiles,
    signedLimit.objects,
    "Custody Mach-O files",
  );
  assert.deepEqual(
    machOFiles.map((row) => row.path),
    [...new Set(machOFiles.map((row) => row.path))].sort(),
  );
  for (const row of machOFiles) {
    retainedUniversalMachO(row, signedPath(row.path));
    const entry = tree.entries.find((entry) => entry.path === row.path);
    assert.equal(entry?.type, "file");
    assert.equal(entry.sha256, row.sha256);
    assert.equal(entry.bytes, row.bytes);
  }
  exactObservation(
    snapshot.fuseWires,
    universalArchitectures,
    "Complete fuse observations",
  );
  exactObservation(
    snapshot.asarIntegrity,
    universalArchitectures,
    "ASAR integrity observations",
  );
  for (const architecture of universalArchitectures) {
    const wire = snapshot.fuseWires[architecture];
    assert.equal(wire.version, "1");
    const count = Object.keys(wire).length - 1;
    assert.ok(count >= 4 && count <= 255);
    exactObservation(
      wire,
      [
        "version",
        ...Array.from({ length: count }, (_, index) => String(index)),
      ],
      "Complete fuse wire",
    );
    for (let index = 0; index < count; index++)
      assert.ok([48, 49, 114, 144].includes(wire[index]), "Unknown fuse state");
    for (const index of [0, 2, 3])
      assert.equal(wire[index], 48, "Required runtime fuse enabled");
    const integrity = exactObservation(
      snapshot.asarIntegrity[architecture],
      ["algorithm", "expectedDigest", "observedDigest"],
      "ASAR integrity",
    );
    assert.equal(integrity.algorithm, "SHA256");
    assert.equal(
      sha256(integrity.expectedDigest),
      sha256(integrity.observedDigest),
    );
  }
  return snapshot;
}

function copiedMetadata(row) {
  const result = Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => !["device", "inode", "ctimeNs"].includes(key),
    ),
  );
  if (row.type === "symlink") delete result.mtimeNs;
  return result;
}

export function assertSignedArtifactCopy({ before, after, policy }) {
  before = signedSnapshot(before);
  after = signedSnapshot(after);
  const metadataPolicy = signedMetadataPolicy(policy.metadata);
  assert.deepEqual(
    after.tree,
    before.tree,
    "Copied artifact bytes/topology differ",
  );
  for (const key of [
    "buildIdentity",
    "machOFiles",
    "fuseWires",
    "asarIntegrity",
  ])
    assert.deepEqual(after[key], before[key], `Copied artifact ${key} differs`);
  for (const observation of [before, after]) {
    const attrs = observation.metadata.entries.flatMap((row) => {
      assert.equal(row.uid, metadataPolicy.ownerUid);
      assert.equal(row.gid, metadataPolicy.ownerGid);
      return row.xattrs.map((attribute) => ({ path: row.path, ...attribute }));
    });
    assert.deepEqual(
      attrs,
      metadataPolicy.allowedXattrs,
      "Copy metadata differs from approved values",
    );
  }
  assert.deepEqual(
    after.metadata.entries.map(copiedMetadata),
    before.metadata.entries.map(copiedMetadata),
    "Copy metadata differs under declared timestamp policy",
  );
  return {
    beforeTreeSha256: before.tree.sha256,
    afterTreeSha256: after.tree.sha256,
    beforeMetadataSha256: before.metadata.sha256,
    afterMetadataSha256: after.metadata.sha256,
    copiedSymlinkMtimes: after.metadata.entries
      .filter((row) => row.type === "symlink")
      .map((row) => ({ path: row.path, mtimeNs: row.mtimeNs })),
  };
}

function validateSignedPlan(value) {
  const plan = exactObservation(
    value,
    [
      "schemaVersion",
      "kind",
      "unsignedTreeSha256",
      "policySha256",
      "objects",
      "signingSteps",
      "sha256",
    ],
    "Signing plan",
  );
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.kind, "signed-artifact-plan");
  sha256(plan.unsignedTreeSha256);
  sha256(plan.policySha256);
  const { sha256: planHash, ...content } = plan;
  assert.equal(sha256(planHash), digest(`${JSON.stringify(content)}\n`));
  assert.deepEqual(plan.signingSteps, insideOut(plan.objects));
  return plan;
}

export function assertSigningStepTransition({
  before,
  after,
  plan,
  signingIndex,
}) {
  before = signedSnapshot(before);
  after = signedSnapshot(after);
  plan = validateSignedPlan(plan);
  assert.ok(
    Number.isInteger(signingIndex) &&
      signingIndex >= 0 &&
      signingIndex < plan.signingSteps.length,
  );
  const object = plan.signingSteps[signingIndex];
  for (const key of ["buildIdentity", "fuseWires", "asarIntegrity"])
    assert.deepEqual(after[key], before[key], `Signing changed ${key}`);
  const expectedPrimaries = plan.objects.map((row) => row.primaryPath).sort();
  assert.deepEqual(
    before.machOFiles.map((row) => row.path),
    expectedPrimaries,
  );
  assert.deepEqual(
    after.machOFiles.map((row) => row.path),
    expectedPrimaries,
  );
  const permitted = new Set([
    object.primaryPath,
    ...object.signatureFiles,
    ...object.signatureDirectories,
  ]);
  const prior = new Map(before.tree.entries.map((row) => [row.path, row]));
  const next = new Map(after.tree.entries.map((row) => [row.path, row]));
  for (const name of [...object.signatureFiles, ...object.signatureDirectories])
    assert.ok(
      next.has(name),
      "Signing did not produce the complete declared signature resources",
    );
  for (const name of new Set([...prior.keys(), ...next.keys()])) {
    const left = prior.get(name),
      right = next.get(name);
    if (!permitted.has(name))
      assert.deepEqual(right, left, "Signing changed an unaffected path");
    else if (name === object.primaryPath) {
      assert.equal(left?.type, "file");
      assert.equal(right?.type, "file");
      assert.equal(right.mode, left.mode);
    } else {
      assert.ok(right, "Signing removed a declared signature resource");
      assert.equal(
        right.type,
        object.signatureFiles.includes(name) ? "file" : "directory",
      );
      assert.equal(
        right.mode,
        left?.mode ?? (right.type === "file" ? 0o644 : 0o755),
      );
    }
  }
  const parentsWithNewEntries = new Set(
    [...next.keys()]
      .filter((name) => !prior.has(name))
      .map((name) => path.posix.dirname(name)),
  );
  const metadataBefore = new Map(
    before.metadata.entries.map((row) => [row.path, row]),
  );
  for (const row of after.metadata.entries) {
    const old = metadataBefore.get(row.path);
    if (!old) {
      assert.ok(permitted.has(row.path) && row.path !== object.primaryPath);
      assert.deepEqual(
        row.xattrs,
        [],
        "Unexpected metadata on new signature resource",
      );
      continue;
    }
    // Atomic replacement is allowed only for the target primary/signature files.
    const allowIdentityChange = permitted.has(row.path) && row.type === "file";
    const allowWriteTime =
      permitted.has(row.path) || parentsWithNewEntries.has(row.path);
    const ignored = new Set(allowWriteTime ? ["mtimeNs", "ctimeNs"] : []);
    if (allowIdentityChange) {
      ignored.add("inode");
      ignored.add("device");
    }
    if (row.type === "directory" && parentsWithNewEntries.has(row.path))
      ignored.add("links");
    const selected = (value) =>
      Object.fromEntries(
        Object.entries(value).filter(([key]) => !ignored.has(key)),
      );
    assert.deepEqual(
      selected(row),
      selected(old),
      "Signing changed undeclared metadata",
    );
  }
  const input = before.machOFiles.find(
    (row) => row.path === object.primaryPath,
  );
  const output = after.machOFiles.find(
    (row) => row.path === object.primaryPath,
  );
  return {
    signingIndex,
    objectPath: object.objectPath,
    beforeTreeSha256: before.tree.sha256,
    afterTreeSha256: after.tree.sha256,
    inputMachO: input,
    outputMachO: output,
    equivalenceClaim: null,
  };
}

export async function inspectSignedArtifactCustody({
  appBundle,
  temporaryRoot,
  expectedBuildIdentity,
  unsignedInventory,
  policy,
  runCommand,
}) {
  policy = signedPolicy(policy);
  const plan = deriveSignedArtifactPlan({
    unsignedInventory,
    policy,
    signingSteps: insideOut(policy.objects),
  });
  expectedBuildIdentity = selectedUniversalIdentity(expectedBuildIdentity);
  assertBuildIdentity(unsignedInventory.buildIdentity, expectedBuildIdentity);
  assertDisjointRoots([appBundle, temporaryRoot]);
  const observed = await signedTree(appBundle);
  const tree = observed.tree;
  const permitted = new Set(
    plan.objects.flatMap((row) => [
      row.primaryPath,
      ...row.signatureFiles,
      ...row.signatureDirectories,
    ]),
  );
  const accepted = new Map(
    unsignedInventory.tree.entries.map((row) => [row.path, row]),
  );
  for (const row of tree.entries) {
    const original = accepted.get(row.path);
    if (!permitted.has(row.path))
      assert.deepEqual(
        row,
        original,
        "Signing custody changed an accepted resource",
      );
    else {
      const signatureDirectory = plan.objects.some((object) =>
        object.signatureDirectories.includes(row.path),
      );
      assert.equal(row.type, signatureDirectory ? "directory" : "file");
      assert.equal(
        row.mode,
        original?.mode ?? (signatureDirectory ? 0o755 : 0o644),
      );
    }
  }
  for (const entry of unsignedInventory.tree.entries)
    assert.ok(
      tree.entries.some((row) => row.path === entry.path),
      "Signing custody lost an accepted path",
    );
  const machOFiles = await inspectMachOTree(appBundle, tree);
  assert.deepEqual(
    machOFiles.map((row) => row.path),
    plan.objects.map((row) => row.primaryPath).sort(),
    "Signing changed the complete Mach-O object set",
  );
  for (const object of plan.objects) {
    const file = await measureRegularFile(
      path.join(appBundle, object.primaryPath),
      true,
    );
    const fileType = ["main", "helper"].includes(object.role)
      ? 2
      : object.role === "addon"
        ? 8
        : 6;
    universalMachO(file.contents, object.primaryPath, fileType);
    if (
      ["main", "helper", "framework"].includes(object.role) &&
      object.objectPath !== standaloneCrashpadPath
    ) {
      const infoPath =
        object.role === "framework"
          ? `${object.objectPath}/Versions/A/Resources/Info.plist`
          : object.role === "main"
            ? "Contents/Info.plist"
            : `${object.objectPath}/Contents/Info.plist`;
      const info = plist.parse(
        (
          await measureRegularFile(path.join(appBundle, infoPath), true)
        ).contents.toString("utf8"),
      );
      assert.equal(
        info.CFBundleIdentifier,
        object.identifier,
        "Candidate identifier differs from signing policy; rebuild required",
      );
      assert.equal(
        info.CFBundleExecutable,
        path.posix.basename(object.primaryPath),
      );
    }
    if (object.role === "framework") {
      for (const [name, target] of [
        [`${object.objectPath}/Versions/Current`, "A"],
        [
          `${object.objectPath}/${path.posix.basename(object.primaryPath)}`,
          `Versions/Current/${path.posix.basename(object.primaryPath)}`,
        ],
      ]) {
        const link = tree.entries.find((row) => row.path === name);
        assert.equal(link?.type, "symlink");
        assert.equal(link.target, target, "Framework alias is not canonical");
      }
    }
  }
  const metadata = await signedMetadata(
    appBundle,
    tree,
    observed.statuses,
    policy.metadata,
    runCommand,
  );
  const resourcesDirectory = path.join(appBundle, "Contents/Resources");
  assert.deepEqual(
    tree.entries
      .filter((row) => row.type === "file" && row.path.endsWith(".asar"))
      .map((row) => row.path),
    ["Contents/Resources/app.asar"],
  );
  assert.deepEqual(
    tree.entries
      .filter((row) => row.type === "file" && row.path.endsWith(".node"))
      .map((row) => row.path),
    nativeDistributionFiles.map(
      (name) => `Contents/Resources/app.asar.unpacked/dist/${name}`,
    ),
  );
  const common = commonObservation(
    unsignedInventory.composition.common,
    expectedBuildIdentity,
  );
  const asar = await inspectUniversalAsar(
    { resourcesDirectory },
    common,
    expectedBuildIdentity,
  );
  assert.equal(asar.packageVersion, unsignedInventory.packageVersion);
  const plistValue = plist.parse(
    (
      await measureRegularFile(
        path.join(appBundle, "Contents/Info.plist"),
        true,
      )
    ).contents.toString("utf8"),
  );
  assert.equal(plistValue.CFBundleVersion, asar.packageVersion);
  assert.equal(plistValue.CFBundleShortVersionString, asar.packageVersion);
  const map = exactObservation(
    plistValue.ElectronAsarIntegrity,
    ["Resources/app.asar"],
    "ASAR integrity map",
  );
  const integrity = exactObservation(
    map["Resources/app.asar"],
    ["algorithm", "hash"],
    "ASAR integrity row",
  );
  assert.equal(integrity.algorithm, "SHA256");
  const header = getRawHeader(asar.archivePath);
  assert.equal(sha256(integrity.hash), digest(header.headerString));
  const expectedDigest = digest(`Resources/app.asarSHA256${integrity.hash}`);
  const framework = machOFiles.find(
    (row) => row.path === frameworkRelativePath,
  );
  assert.ok(framework, "Missing fixed Electron framework");
  const file = await measureRegularFile(
    path.join(appBundle, frameworkRelativePath),
    true,
  );
  const asarIntegrity = {},
    fuseWires = {};
  const temporaryFence = await createUniversalOutput(temporaryRoot);
  for (const architecture of universalArchitectures) {
    const slice = framework.slices[architecture];
    const thin = file.contents.subarray(
      slice.offset,
      slice.offset + slice.bytes,
    );
    const sentinel = thin.indexOf(integritySentinel);
    assert.ok(
      sentinel >= 0 && thin.indexOf(integritySentinel, sentinel + 1) === -1,
      "Ambiguous or missing framework integrity sentinel",
    );
    const offset = sentinel + integritySentinel.length;
    assert.ok(offset <= thin.length - 34);
    assert.equal(thin[offset], 1);
    assert.equal(thin[offset + 1], 1);
    const observedDigest = thin
      .subarray(offset + 2, offset + 34)
      .toString("hex");
    assert.equal(observedDigest, expectedDigest);
    asarIntegrity[architecture] = {
      algorithm: "SHA256",
      expectedDigest,
      observedDigest,
    };
    const thinPath = path.join(
      temporaryRoot,
      `signed-custody-framework-${architecture}.bin`,
    );
    await writeUniversalFile(thinPath, thin, 0o600, temporaryFence);
    fuseWires[architecture] = await getCurrentFuseWire(thinPath);
    assert.deepEqual(
      await measureRegularFile(thinPath),
      { sha256: slice.sha256, bytes: slice.bytes },
      "Fuse observation changed its disposable thin copy",
    );
  }
  const result = signedSnapshot({
    schemaVersion: 1,
    kind: "signed-artifact-custody",
    buildIdentity: asar.buildIdentity,
    tree,
    machOFiles,
    metadata,
    fuseWires,
    asarIntegrity,
  });
  assert.deepEqual(
    (await signedTree(appBundle)).tree,
    tree,
    "App changed during signed custody inspection",
  );
  for (const [relative, before] of observed.statuses)
    sameFile(
      before,
      await fs.lstat(path.join(appBundle, relative === "." ? "" : relative), {
        bigint: true,
      }),
    );
  await temporaryFence();
  return result;
}

export function expectedDesktopDistributionFiles(platform = process.platform) {
  assert.ok(
    ["darwin", "linux", "win32"].includes(platform),
    "Unsupported artifact platform",
  );
  return [
    "build-identity.json",
    "calculator/host.js",
    "calculator/index.html",
    "calculator/styles.css",
    "index.html",
    "main.js",
    ...(platform === "darwin" ? nativeDistributionFiles : []),
    "preload.cjs",
    "renderer.js",
    "styles.css",
  ];
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameFile(before, after) {
  for (const key of [
    "dev",
    "ino",
    "mode",
    "nlink",
    "size",
    "mtimeMs",
    "ctimeMs",
  ]) {
    assert.equal(
      after[key],
      before[key],
      "Artifact file changed during inspection",
    );
  }
}

async function measureRegularFile(filename, retainBytes = false) {
  const before = await fs.lstat(filename);
  assert.ok(
    before.isFile() && !before.isSymbolicLink(),
    "Artifact must be a regular file",
  );
  assert.equal(before.nlink, 1, "Artifact must not be hardlinked");
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    sameFile(before, await handle.stat());
    const hash = createHash("sha256");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytes += chunk.length;
      if (retainBytes) chunks.push(chunk);
    }
    assert.equal(bytes, before.size, "Artifact size changed during inspection");
    sameFile(before, await handle.stat());
    sameFile(before, await fs.lstat(filename));
    return {
      sha256: hash.digest("hex"),
      bytes,
      ...(retainBytes ? { contents: Buffer.concat(chunks) } : {}),
    };
  } finally {
    await handle.close();
  }
}

function assertContained(root, filename) {
  const relative = path.relative(root, filename);
  assert.ok(
    relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    "Artifact link escapes the owned tree",
  );
}

async function assertDirectory(root) {
  assert.ok(path.isAbsolute(root), "Artifact root must be absolute");
  assert.equal(root, path.resolve(root), "Artifact root must be normalized");
  let current = path.parse(root).root;
  for (const component of path
    .relative(current, root)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    const status = await fs.lstat(current);
    assert.ok(
      status.isDirectory() && !status.isSymbolicLink(),
      "Artifact directory ancestry must not contain symlinks",
    );
  }
}

// Resolve only contained components. Never traverse a link outside the tree,
// including an intermediate link whose final target could lead back inside.
async function validateContainedLink(root, relativePath) {
  let pending = relativePath.split("/");
  let current = root;
  let links = 0;
  while (pending.length > 0) {
    const component = pending.shift();
    const filename = path.resolve(current, component);
    assertContained(root, filename);
    const status = await fs.lstat(filename);
    if (status.isSymbolicLink()) {
      assert.ok(++links <= 40, "Artifact link cycle or excessive indirection");
      const target = await fs.readlink(filename);
      assert.equal(
        path.isAbsolute(target),
        false,
        "Artifact links must be relative",
      );
      const resolved = path.resolve(path.dirname(filename), target);
      assertContained(root, resolved);
      pending = [
        ...path.relative(root, resolved).split(path.sep).filter(Boolean),
        ...pending,
      ];
      current = root;
    } else {
      if (pending.length > 0)
        assert.ok(
          status.isDirectory(),
          "Artifact link parent must be a directory",
        );
      current = filename;
    }
  }
}

export async function inspectArtifactTree(root, { allowSymlinks = true } = {}) {
  await assertDirectory(root);
  const entries = [];
  async function visit(relativeDirectory) {
    const directory = path.join(root, relativeDirectory);
    const before = await fs.lstat(directory);
    assert.ok(
      before.isDirectory() && !before.isSymbolicLink(),
      "Artifact directory was substituted",
    );
    const children = await fs.readdir(directory);
    for (const name of children.sort()) {
      const relativePath = path.posix.join(relativeDirectory, name);
      const filename = path.join(root, relativePath);
      const status = await fs.lstat(filename);
      const mode = status.mode & 0o777;
      if (status.isSymbolicLink()) {
        assert.ok(allowSymlinks, "Artifact inventory does not allow symlinks");
        const target = await fs.readlink(filename);
        await validateContainedLink(root, relativePath);
        sameFile(status, await fs.lstat(filename));
        entries.push({ path: relativePath, type: "symlink", mode, target });
      } else if (status.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", mode });
        await visit(relativePath);
      } else {
        entries.push({
          path: relativePath,
          type: "file",
          mode,
          ...(await measureRegularFile(filename)),
        });
      }
    }
    sameFile(before, await fs.lstat(directory));
  }
  await visit("");
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return { entries, sha256: digest(JSON.stringify(entries)) };
}

export function assertBuildIdentity(value, expected = null) {
  if (expected === null) {
    assert.equal(
      value,
      null,
      "Ordinary development artifact must have null build identity",
    );
    return null;
  }
  const parsedExpected = parseClientBuildIdentity(expected);
  const parsedValue = parseClientBuildIdentity(value);
  assert.notEqual(parsedExpected, null, "Candidate build identity is invalid");
  assert.notEqual(parsedValue, null, "Embedded build identity is invalid");
  assert.deepEqual(
    value,
    expected,
    "Embedded artifact build identity differs from the selected candidate",
  );
  return parsedValue;
}

function inspectBuildIdentityAsset(bytes, expectedBuildIdentity) {
  assert.ok(bytes.length <= 2048, "Build identity asset is oversized");
  const text = bytes.toString("utf8");
  const value = JSON.parse(text);
  assert.equal(
    text,
    `${JSON.stringify(value)}\n`,
    "Build identity asset must be compact JSON plus one newline",
  );
  return assertBuildIdentity(value, expectedBuildIdentity);
}

export function inspectMachOHeader(bytes, architecture, fileType = 8) {
  assert.ok(
    bytes.length >= 32,
    "Native artifact must contain a Mach-O64 header",
  );
  assert.equal(
    bytes.readUInt32LE(0),
    0xfeedfacf,
    "Native artifact must be little-endian Mach-O64",
  );
  assert.ok(
    ["arm64", "x64"].includes(architecture),
    "Native artifact architecture is unsupported",
  );
  assert.equal(
    bytes.readUInt32LE(4),
    architecture === "arm64" ? 0x0100000c : 0x01000007,
    "Native artifact CPU must match the selected runtime",
  );
  assert.equal(
    bytes.readUInt32LE(12),
    fileType,
    "Native artifact has an unexpected Mach-O file type",
  );
  return architecture;
}

export async function inspectNativeArtifact(
  root,
  relativePath,
  architecture = process.arch,
) {
  assert.ok(nativeDistributionFiles.includes(relativePath));
  await assertDirectory(root);
  await assertDirectory(path.join(root, "native"));
  const { contents, ...measurement } = await measureRegularFile(
    path.join(root, relativePath),
    true,
  );
  inspectMachOHeader(contents, architecture);
  return { path: `dist/${relativePath}`, architecture, ...measurement };
}

export async function inspectDesktopDistribution({
  distributionRoot,
  platform = process.platform,
  architecture = process.arch,
  expectedBuildIdentity = null,
}) {
  assert.ok(
    ["arm64", "x64"].includes(architecture),
    "Artifact architecture is unsupported",
  );
  const tree = await inspectArtifactTree(distributionRoot, {
    allowSymlinks: false,
  });
  const files = tree.entries.filter((entry) => entry.type === "file");
  assert.deepEqual(
    files.map((entry) => entry.path),
    expectedDesktopDistributionFiles(platform),
    "Production build must contain only the reviewed runtime assets and no source maps",
  );
  assert.deepEqual(
    tree.entries
      .filter((entry) => entry.type === "directory")
      .map((entry) => entry.path),
    ["calculator", ...(platform === "darwin" ? ["native"] : [])],
    "Unexpected distribution directory",
  );
  const identityBytes = await measureRegularFile(
    path.join(distributionRoot, "build-identity.json"),
    true,
  );
  assert.equal(
    identityBytes.sha256,
    files.find((entry) => entry.path === "build-identity.json").sha256,
  );
  const buildIdentity = inspectBuildIdentityAsset(
    identityBytes.contents,
    expectedBuildIdentity,
  );
  const nativeArtifacts =
    platform === "darwin"
      ? await Promise.all(
          nativeDistributionFiles.map((relativePath) =>
            inspectNativeArtifact(distributionRoot, relativePath, architecture),
          ),
        )
      : [];
  for (const artifact of nativeArtifacts)
    assert.equal(
      artifact.sha256,
      files.find((entry) => `dist/${entry.path}` === artifact.path).sha256,
    );
  return { files, buildIdentity, nativeArtifacts };
}

export async function selectExistingElectronArchive({
  repositoryRoot,
  electronVersion,
  platform = process.platform,
  architecture = process.arch,
  directory = process.env.DESMOSLOCK_ELECTRON_ZIP_DIR,
}) {
  assert.equal(
    electronVersion,
    "44.10.0",
    "Packaging requires the reviewed Electron version",
  );
  assert.ok(
    ["darwin", "linux", "win32"].includes(platform),
    "Packaging platform is unsupported",
  );
  assert.ok(
    ["arm64", "x64"].includes(architecture),
    "Packaging architecture is unsupported",
  );
  const filename = `electron-v${electronVersion}-${platform}-${architecture}.zip`;
  const checksums = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "node_modules/electron/checksums.json"),
      "utf8",
    ),
  );
  const expectedHash = checksums[filename];
  assert.match(
    expectedHash ?? "",
    /^[0-9a-f]{64}$/,
    "The installed Electron package must pin the exact archive checksum",
  );
  if (directory === undefined) {
    // Address one existing official cache entry, matching @electron/get's
    // Cache.getCacheDirectory and env-paths('electron', { suffix: '' }).
    // npm ci already populates this entry in CI; this verifier never downloads.
    const defaultCacheRoot =
      platform === "darwin"
        ? path.join(os.homedir(), "Library/Caches/electron")
        : platform === "win32"
          ? path.join(
              process.env.LOCALAPPDATA ||
                path.join(os.homedir(), "AppData/Local"),
              "electron/Cache",
            )
          : path.join(
              process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
              "electron",
            );
    const cacheRoot = process.env.electron_config_cache ?? defaultCacheRoot;
    assert.equal(
      path.isAbsolute(cacheRoot),
      true,
      "The selected Electron cache root must be absolute",
    );
    const releaseDirectory = `https://github.com/electron/electron/releases/download/v${electronVersion}`;
    directory = path.join(
      cacheRoot,
      createHash("sha256").update(releaseDirectory).digest("hex"),
    );
  }
  assert.equal(
    path.isAbsolute(directory),
    true,
    "The selected Electron ZIP directory must be absolute",
  );
  const archivePath = path.join(directory, filename);
  let status;
  try {
    status = await fs.lstat(archivePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      `Required existing ${filename} is unavailable. Select its verified directory with DESMOSLOCK_ELECTRON_ZIP_DIR or retain npm ci's official Electron cache; this verifier will not download or search for it.`,
      { cause: error },
    );
  }
  assert.equal(
    status.isFile() && !status.isSymbolicLink(),
    true,
    "The selected Electron ZIP must be a regular archive file",
  );
  assert.equal(
    status.nlink,
    1,
    "The selected Electron ZIP must not be hardlinked",
  );
  const { sha256, bytes } = await measureRegularFile(archivePath);
  assert.equal(
    bytes,
    status.size,
    "The selected Electron archive changed while being verified",
  );
  assert.equal(
    sha256,
    expectedHash,
    "The existing Electron archive does not match the installed package's checksum",
  );
  if (platform === "darwin" && architecture === "arm64") {
    assert.equal(
      sha256,
      "8e9f6041d3aa62229332b033d0390fd213a9b10cd078163f3f5fe988ee91baf7",
    );
    assert.equal(bytes, 130_767_830);
  }
  return { directory: await fs.realpath(directory), filename, sha256, bytes };
}

export async function desktopPackagePaths(
  packageDirectory,
  platform = process.platform,
) {
  expectedDesktopDistributionFiles(platform);
  await assertDirectory(packageDirectory);
  const appBundle =
    platform === "darwin"
      ? path.join(packageDirectory, `${appName}.app`)
      : null;
  const executable =
    platform === "darwin"
      ? path.join(appBundle, "Contents", "MacOS", packagedExecutableName)
      : path.join(
          packageDirectory,
          `${packagedExecutableName}${platform === "win32" ? ".exe" : ""}`,
        );
  const resourcesDirectory =
    platform === "darwin"
      ? path.join(appBundle, "Contents", "Resources")
      : path.join(packageDirectory, "resources");
  await assertDirectory(path.dirname(executable));
  await assertDirectory(resourcesDirectory);
  const executableStatus = await fs.lstat(executable);
  assert.ok(
    executableStatus.isFile() && !executableStatus.isSymbolicLink(),
    "Packaged executable must be a regular file",
  );
  assert.equal(
    executableStatus.nlink,
    1,
    "Packaged executable must not be hardlinked",
  );
  if (platform !== "win32")
    assert.notEqual(
      executableStatus.mode & 0o111,
      0,
      "Packaged executable must have an executable mode bit",
    );
  return { packageDirectory, appBundle, executable, resourcesDirectory };
}

export async function inspectPackagedDesktop({
  packageDirectory,
  distribution,
  platform = process.platform,
  architecture = process.arch,
  expectedBuildIdentity = null,
}) {
  assert.ok(
    ["arm64", "x64"].includes(architecture),
    "Artifact architecture is unsupported",
  );
  const paths = await desktopPackagePaths(packageDirectory, platform);
  const tree = await inspectArtifactTree(paths.appBundle ?? packageDirectory);
  const archivePath = path.join(paths.resourcesDirectory, "app.asar");
  await assertDirectory(paths.resourcesDirectory);
  const archive = await measureRegularFile(archivePath);
  uncache(archivePath);
  const archiveEntries = listPackage(archivePath)
    .map((listedFilename) => {
      const filename =
        process.platform === "win32"
          ? listedFilename.split("\\").join("/")
          : listedFilename;
      assert.ok(filename.startsWith("/"));
      const relativePath = filename.slice(1);
      assert.ok(
        relativePath !== "" &&
          !relativePath.includes("\\") &&
          relativePath
            .split("/")
            .every((part) => part !== "" && part !== "." && part !== ".."),
        "Invalid ASAR path",
      );
      const entry = statFile(archivePath, relativePath, false);
      assert.equal(
        "link" in entry,
        false,
        "ASAR inventory must not contain links",
      );
      return {
        path: relativePath,
        directory: "files" in entry,
        unpacked: entry.unpacked === true,
      };
    })
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  const expectedFiles = [
    ...expectedDesktopDistributionFiles(platform).map(
      (filename) => `dist/${filename}`,
    ),
    "package.json",
  ].sort();
  assert.deepEqual(
    archiveEntries
      .filter((entry) => !entry.directory)
      .map((entry) => entry.path),
    expectedFiles,
    "ASAR inventory differs from reviewed runtime assets",
  );
  assert.deepEqual(
    archiveEntries
      .filter((entry) => entry.directory)
      .map((entry) => entry.path),
    [
      "dist",
      "dist/calculator",
      ...(platform === "darwin" ? ["dist/native"] : []),
    ],
  );
  assert.deepEqual(
    archiveEntries
      .filter((entry) => !entry.directory && entry.unpacked)
      .map((entry) => entry.path),
    platform === "darwin"
      ? nativeDistributionFiles.map((filename) => `dist/${filename}`)
      : [],
    "Only the two native artifacts may be unpacked",
  );
  const unpackedRoot = path.join(paths.resourcesDirectory, "app.asar.unpacked");
  if (platform === "darwin") {
    const unpackedTree = await inspectArtifactTree(unpackedRoot, {
      allowSymlinks: false,
    });
    assert.deepEqual(
      unpackedTree.entries.map((entry) => entry.path),
      [
        "dist",
        "dist/native",
        ...nativeDistributionFiles.map((filename) => `dist/${filename}`),
      ],
    );
  } else {
    await assert.rejects(
      fs.lstat(unpackedRoot),
      { code: "ENOENT" },
      "Non-Mac package must not contain unpacked assets",
    );
  }
  const packagedFiles = expectedDesktopDistributionFiles(platform).map(
    (filename) => {
      const bytes = extractFile(archivePath, `dist/${filename}`, false);
      return { path: filename, bytes: bytes.length, sha256: digest(bytes) };
    },
  );
  if (distribution !== undefined) {
    assert.deepEqual(
      packagedFiles,
      distribution.files.map(({ path: filename, bytes, sha256 }) => ({
        path: filename,
        bytes,
        sha256,
      })),
      "Packaged runtime bytes differ from the inspected distribution",
    );
  }
  const identityBytes = extractFile(
    archivePath,
    "dist/build-identity.json",
    false,
  );
  const buildIdentity = inspectBuildIdentityAsset(
    identityBytes,
    expectedBuildIdentity,
  );
  const packageMetadata = JSON.parse(
    extractFile(archivePath, "package.json", false).toString("utf8"),
  );
  // Packager removes the staging-only private field before creating ASAR.
  assert.deepEqual(Object.keys(packageMetadata).sort(), [
    "main",
    "name",
    "productName",
    "type",
    "version",
  ]);
  assert.deepEqual(
    { ...packageMetadata, version: undefined },
    {
      main: "dist/main.js",
      name: packagedExecutableName,
      productName: appName,
      type: "module",
      version: undefined,
    },
  );
  assert.match(
    packageMetadata.version,
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/,
  );
  const nativeArtifacts =
    platform === "darwin"
      ? await Promise.all(
          nativeDistributionFiles.map((relativePath) =>
            inspectNativeArtifact(
              path.join(unpackedRoot, "dist"),
              relativePath,
              architecture,
            ),
          ),
        )
      : [];
  if (distribution !== undefined)
    assert.deepEqual(
      nativeArtifacts,
      distribution.nativeArtifacts,
      "Packaged native artifact differs from its distribution",
    );
  const { contents: executableBytes, ...executable } = await measureRegularFile(
    paths.executable,
    platform === "darwin",
  );
  if (platform === "darwin")
    inspectMachOHeader(executableBytes, architecture, 2);
  const infoPlist =
    platform === "darwin"
      ? await measureRegularFile(
          path.join(paths.appBundle, "Contents", "Info.plist"),
        )
      : null;
  const fuses = await verifyPackagedElectronFuses(paths.executable);
  assert.deepEqual(fuses, {
    EnableNodeCliInspectArguments: "DISABLE",
    EnableNodeOptionsEnvironmentVariable: "DISABLE",
    RunAsNode: "DISABLE",
  });
  assert.deepEqual(
    await measureRegularFile(archivePath),
    archive,
    "ASAR changed during inspection",
  );
  // Bind every separately observed file to the completed app-tree snapshot.
  const treeRoot = paths.appBundle ?? packageDirectory;
  const measurements = {
    executable: {
      path: path.relative(treeRoot, paths.executable).split(path.sep).join("/"),
      ...executable,
      architecture: platform === "darwin" ? architecture : null,
    },
    asar: {
      path: path.relative(treeRoot, archivePath).split(path.sep).join("/"),
      ...archive,
    },
    infoPlist:
      infoPlist === null ? null : { path: "Contents/Info.plist", ...infoPlist },
  };
  for (const measurement of [
    ...Object.values(measurements).filter((value) => value !== null),
    ...nativeArtifacts.map((artifact) => ({
      ...artifact,
      path: path
        .relative(treeRoot, path.join(unpackedRoot, artifact.path))
        .split(path.sep)
        .join("/"),
    })),
  ]) {
    const entry = tree.entries.find((value) => value.path === measurement.path);
    assert.equal(entry?.type, "file");
    assert.equal(
      entry.sha256,
      measurement.sha256,
      "Artifact tree and file measurements disagree",
    );
    assert.equal(entry.bytes, measurement.bytes);
  }
  assert.deepEqual(
    await inspectArtifactTree(treeRoot),
    tree,
    "Artifact tree changed during inspection",
  );
  return {
    ...paths,
    platform,
    architecture,
    buildIdentity,
    packageVersion: packageMetadata.version,
    nativeArtifacts,
    fuses,
    measurements,
    tree,
  };
}

async function readWorkspaceVersion(repositoryRoot) {
  const read = async (filename) =>
    JSON.parse(await fs.readFile(path.join(repositoryRoot, filename), "utf8"));
  const [root, desktop, lock] = await Promise.all([
    read("package.json"),
    read("apps/desktop/package.json"),
    read("package-lock.json"),
  ]);
  assert.equal(root.name, "desmoslock");
  assert.equal(desktop.name, "@desmoslock/desktop");
  assert.match(root.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(lock.lockfileVersion, 3);
  for (const version of [
    desktop.version,
    lock.version,
    lock.packages?.[""]?.version,
    lock.packages?.["apps/desktop"]?.version,
  ])
    assert.equal(
      version,
      root.version,
      "Workspace and lockfile package versions differ",
    );
  return root.version;
}

export async function packageUnsignedDesktop({
  repositoryRoot,
  distributionRoot,
  stageRoot,
  outputRoot,
  temporaryRoot,
  electronVersion,
  electronArchive,
  platform = process.platform,
  architecture = process.arch,
  expectedBuildIdentity = null,
}) {
  assert.equal(
    platform,
    process.platform,
    "Unsigned packaging only supports the current host platform",
  );
  assert.equal(
    architecture,
    process.arch,
    "Unsigned packaging only establishes the current host architecture",
  );
  const version = await readWorkspaceVersion(repositoryRoot);
  const distribution = await inspectDesktopDistribution({
    distributionRoot,
    platform,
    architecture,
    expectedBuildIdentity,
  });
  const archive = await selectExistingElectronArchive({
    repositoryRoot,
    electronVersion,
    platform,
    architecture,
    directory: electronArchive.directory,
  });
  assert.deepEqual(
    archive,
    electronArchive,
    "Selected Electron archive changed before packaging",
  );
  const roots = [stageRoot, outputRoot, temporaryRoot, distributionRoot].map(
    (root) => {
      assert.ok(path.isAbsolute(root), "Packaging paths must be absolute");
      return path.resolve(root);
    },
  );
  for (let left = 0; left < roots.length; left += 1)
    for (let right = left + 1; right < roots.length; right += 1) {
      const relative = path.relative(roots[left], roots[right]);
      const reverse = path.relative(roots[right], roots[left]);
      assert.ok(
        relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
        "Packaging roots must be disjoint",
      );
      assert.ok(
        reverse.startsWith(`..${path.sep}`) || path.isAbsolute(reverse),
        "Packaging roots must be disjoint",
      );
    }
  for (const root of roots.slice(0, 3)) {
    await assertDirectory(path.dirname(root));
    await fs.mkdir(root, { mode: 0o700 });
  }
  await fs.cp(distributionRoot, path.join(stageRoot, "dist"), {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  assert.deepEqual(
    await inspectDesktopDistribution({
      distributionRoot: path.join(stageRoot, "dist"),
      platform,
      architecture,
      expectedBuildIdentity,
    }),
    distribution,
    "Staged runtime differs from the inspected distribution",
  );
  await fs.writeFile(
    path.join(stageRoot, "package.json"),
    `${JSON.stringify({ main: "dist/main.js", name: packagedExecutableName, private: true, productName: appName, type: "module", version }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const packageDirectories = await packager({
    arch: architecture,
    // ASAR matches absolute source names with matchBase. Exact inventories
    // constrain these two basenames to their fixed dist/native paths.
    asar:
      platform === "darwin"
        ? { unpack: "{aac-protection,durable-record}.node" }
        : true,
    dir: stageRoot,
    electronVersion,
    electronZipDir: archive.directory,
    executableName: packagedExecutableName,
    name: appName,
    osxSign: false,
    out: outputRoot,
    tmpdir: temporaryRoot,
    overwrite: false,
    platform,
    prune: false,
    quiet: true,
  });
  assert.equal(packageDirectories.length, 1);
  const packageDirectory = path.resolve(packageDirectories[0]);
  assert.equal(
    path.dirname(packageDirectory),
    path.resolve(outputRoot),
    "Packager returned an unexpected output directory",
  );
  const packaged = await desktopPackagePaths(packageDirectory, platform);
  await hardenPackagedElectron(packaged.executable, platform, architecture);
  const inspection = await inspectPackagedDesktop({
    packageDirectory,
    distribution,
    platform,
    architecture,
    expectedBuildIdentity,
  });
  assert.equal(
    inspection.packageVersion,
    version,
    "Packager changed the workspace version",
  );
  return { ...inspection, distribution, electronArchive: archive };
}

const universalArchitectures = Object.freeze(["arm64", "x64"]);
const disabledFuseObservation = Object.freeze({
  EnableNodeCliInspectArguments: "DISABLE",
  EnableNodeOptionsEnvironmentVariable: "DISABLE",
  RunAsNode: "DISABLE",
});
const frameworkRelativePath =
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework";
const integritySentinel = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");

function exactObservation(value, keys, label) {
  assert.ok(
    value !== null && typeof value === "object",
    `${label} must be a record`,
  );
  assert.ok(
    [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    `${label} must be an ordinary record`,
  );
  assert.deepEqual(
    Reflect.ownKeys(value).sort(),
    [...keys].sort(),
    `${label} has unexpected fields`,
  );
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(
      descriptor && "value" in descriptor && descriptor.enumerable,
      `${label} must contain data fields`,
    );
    copy[key] = descriptor.value;
  }
  return copy;
}

function exactRows(value, count, label) {
  assert.ok(
    Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype,
    `${label} must be an array`,
  );
  assert.equal(value.length, count, `${label} has an unexpected length`);
  assert.deepEqual(
    Reflect.ownKeys(value).sort(),
    [...Array(count).keys()].map(String).concat("length").sort(),
  );
  return Array.from({ length: count }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    assert.ok(
      descriptor && "value" in descriptor && descriptor.enumerable,
      `${label} must contain data rows`,
    );
    return descriptor.value;
  });
}

function positiveBytes(value) {
  assert.ok(
    Number.isSafeInteger(value) && value > 0,
    "Observation byte length must be positive and bounded",
  );
  return value;
}

function sha256(value) {
  assert.equal(typeof value, "string");
  assert.match(value, /^(?!0{64}$)[0-9a-f]{64}$/);
  return value;
}

function measuredFields(value) {
  return { sha256: sha256(value.sha256), bytes: positiveBytes(value.bytes) };
}

function observationPath(value) {
  assert.equal(typeof value, "string");
  assert.ok(
    value.length > 0 &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Observation path must be relative and normalized",
  );
  return value;
}

function commonObservation(value, expectedBuildIdentity) {
  const record = exactObservation(
    value,
    ["files", "buildIdentity"],
    "Common observation",
  );
  const names = expectedDesktopDistributionFiles("linux");
  const files = exactRows(record.files, names.length, "Common files").map(
    (value, index) => {
      const row = exactObservation(
        value,
        ["path", "type", "mode", "sha256", "bytes"],
        "Common file",
      );
      assert.equal(row.path, names[index]);
      assert.equal(row.type, "file");
      assert.ok(
        Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o777,
      );
      return {
        path: row.path,
        type: row.type,
        mode: row.mode,
        ...measuredFields(row),
      };
    },
  );
  return {
    files,
    buildIdentity: assertBuildIdentity(
      record.buildIdentity,
      expectedBuildIdentity,
    ),
  };
}

function selectedUniversalIdentity(value) {
  const identity = parseClientBuildIdentity(value);
  assert.notEqual(
    identity,
    null,
    "Universal artifacts require a selected build identity",
  );
  return identity;
}

export async function inspectDesktopCommon({
  commonRoot,
  expectedBuildIdentity,
}) {
  expectedBuildIdentity = selectedUniversalIdentity(expectedBuildIdentity);
  const { files, buildIdentity } = await inspectDesktopDistribution({
    distributionRoot: commonRoot,
    platform: "linux",
    architecture: process.arch,
    expectedBuildIdentity,
  });
  return { files, buildIdentity };
}

async function copyDesktopCommon(commonRoot, outputRoot, common, stageFence) {
  const outputFence = await createUniversalOutput(outputRoot, stageFence);
  const calculatorFence = await createUniversalOutput(
    path.join(outputRoot, "calculator"),
    outputFence,
  );
  for (const row of common.files) {
    await assertDirectory(path.dirname(path.join(commonRoot, row.path)));
    const { contents, ...measurement } = await measureRegularFile(
      path.join(commonRoot, row.path),
      true,
    );
    assert.deepEqual(
      measurement,
      { sha256: row.sha256, bytes: row.bytes },
      "Common file changed before copying",
    );
    await writeUniversalFile(
      path.join(outputRoot, row.path),
      contents,
      row.mode,
      row.path.startsWith("calculator/") ? calculatorFence : outputFence,
    );
  }
  await outputFence();
  await calculatorFence();
  return async () => {
    await outputFence();
    await calculatorFence();
  };
}

function universalMachO(bytes, relativePath, expectedFileType) {
  assert.ok(
    bytes.length >= 8,
    "Universal artifact is missing its fat Mach-O header",
  );
  const magic = bytes.readUInt32BE(0);
  assert.ok(
    [0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic),
    "Every Mach-O must be universal",
  );
  const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
  const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
  const u32 = (offset) =>
    littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const u64 = (offset) => {
    const value = littleEndian
      ? bytes.readBigUInt64LE(offset)
      : bytes.readBigUInt64BE(offset);
    assert.ok(
      value <= BigInt(Number.MAX_SAFE_INTEGER),
      "Fat Mach-O offset exceeds safe integer range",
    );
    return Number(value);
  };
  assert.equal(u32(4), 2, "Universal Mach-O must contain exactly two slices");
  const rowBytes = fat64 ? 32 : 20;
  const tableEnd = 8 + rowBytes * 2;
  assert.ok(bytes.length >= tableEnd, "Truncated fat Mach-O table");
  const slices = {};
  let fileType;
  for (let index = 0; index < 2; index += 1) {
    const row = 8 + index * rowBytes;
    const cpu = u32(row);
    const architecture =
      cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x64" : null;
    assert.notEqual(architecture, null, "Unexpected fat Mach-O CPU");
    assert.equal(
      slices[architecture],
      undefined,
      "Duplicate fat Mach-O architecture",
    );
    const offset = fat64 ? u64(row + 8) : u32(row + 8);
    const length = fat64 ? u64(row + 16) : u32(row + 12);
    const alignment = u32(row + (fat64 ? 24 : 16));
    if (fat64)
      assert.equal(u32(row + 28), 0, "Fat64 reserved field must be zero");
    assert.ok(alignment <= 31, "Invalid fat Mach-O alignment");
    assert.ok(
      offset >= tableEnd && length >= 32 && offset <= bytes.length - length,
      "Fat Mach-O slice is out of bounds",
    );
    assert.equal(offset % 2 ** alignment, 0, "Misaligned fat Mach-O slice");
    const thin = bytes.subarray(offset, offset + length);
    const currentType = thin.readUInt32LE(12);
    assert.ok(
      [2, 6, 8].includes(currentType),
      "Unsupported inner Mach-O file type",
    );
    inspectMachOHeader(thin, architecture, expectedFileType ?? currentType);
    assert.equal(
      thin.readUInt32LE(8),
      u32(row + 4),
      "Inner Mach-O CPU subtype disagrees with fat table",
    );
    if (fileType !== undefined)
      assert.equal(
        currentType,
        fileType,
        "Universal slice file types disagree",
      );
    fileType = currentType;
    const commandCount = thin.readUInt32LE(16);
    const commandBytes = thin.readUInt32LE(20);
    assert.ok(
      commandBytes <= length - 32 && commandCount <= commandBytes / 8,
      "Invalid Mach-O load-command extent",
    );
    let cursor = 32;
    for (let command = 0; command < commandCount; command += 1) {
      assert.ok(
        cursor <= 32 + commandBytes - 8,
        "Truncated Mach-O load command",
      );
      const size = thin.readUInt32LE(cursor + 4);
      assert.ok(
        size >= 8 && size % 8 === 0 && size <= 32 + commandBytes - cursor,
        "Invalid Mach-O load command size",
      );
      cursor += size;
    }
    assert.equal(
      cursor,
      32 + commandBytes,
      "Mach-O load-command lengths disagree",
    );
    slices[architecture] = { offset, bytes: length, sha256: digest(thin) };
  }
  const [left, right] = Object.values(slices).sort(
    (a, b) => a.offset - b.offset,
  );
  assert.ok(
    left.offset + left.bytes <= right.offset,
    "Overlapping fat Mach-O slices",
  );
  return {
    path: relativePath,
    sha256: digest(bytes),
    bytes: bytes.length,
    slices: { arm64: slices.arm64, x64: slices.x64 },
  };
}

function retainedUniversalMachO(value, relativePath) {
  const row = exactObservation(
    value,
    ["path", "sha256", "bytes", "slices"],
    "Retained universal Mach-O",
  );
  assert.equal(row.path, relativePath);
  const measurement = measuredFields(row);
  const slices = exactObservation(
    row.slices,
    universalArchitectures,
    "Retained Mach-O slices",
  );
  for (const architecture of universalArchitectures) {
    const slice = exactObservation(
      slices[architecture],
      ["offset", "bytes", "sha256"],
      "Retained Mach-O slice",
    );
    assert.ok(
      Number.isSafeInteger(slice.offset) &&
        slice.offset >= 48 &&
        slice.bytes >= 32 &&
        slice.offset <= measurement.bytes - slice.bytes,
      "Retained Mach-O slice is out of bounds",
    );
    slices[architecture] = { offset: slice.offset, ...measuredFields(slice) };
  }
  const [left, right] = Object.values(slices).sort(
    (a, b) => a.offset - b.offset,
  );
  assert.ok(
    left.offset + left.bytes <= right.offset,
    "Retained Mach-O slices overlap",
  );
  return { path: row.path, ...measurement, slices };
}

async function readNativeSlices(value) {
  const slices = exactObservation(
    value,
    universalArchitectures,
    "Native slice observations",
  );
  const result = {};
  for (const architecture of universalArchitectures) {
    const input = exactObservation(
      slices[architecture],
      ["root", "artifacts"],
      "Native slice input",
    );
    await assertDirectory(input.root);
    assert.equal(path.basename(input.root), "native");
    const tree = await inspectArtifactTree(input.root, {
      allowSymlinks: false,
    });
    assert.deepEqual(
      tree.entries.map((entry) => entry.path),
      nativeDistributionFiles.map((name) => path.basename(name)),
    );
    const artifacts = exactRows(input.artifacts, 2, "Native artifacts").map(
      (value, index) => {
        const row = exactObservation(
          value,
          ["path", "architecture", "sha256", "bytes"],
          "Native artifact",
        );
        assert.equal(row.path, `dist/${nativeDistributionFiles[index]}`);
        assert.equal(row.architecture, architecture);
        return { path: row.path, architecture, ...measuredFields(row) };
      },
    );
    const observed = await Promise.all(
      nativeDistributionFiles.map((name) =>
        inspectNativeArtifact(path.dirname(input.root), name, architecture),
      ),
    );
    assert.deepEqual(
      observed,
      artifacts,
      "Compiler output differs from retained native observation",
    );
    result[architecture] = { root: input.root, artifacts };
  }
  assertDisjointRoots(
    universalArchitectures.map((architecture) => result[architecture].root),
  );
  return result;
}

function assertDisjointRoots(roots) {
  for (const root of roots) {
    assert.ok(path.isAbsolute(root), "Universal roots must be absolute");
    assert.equal(
      root,
      path.resolve(root),
      "Universal roots must be normalized",
    );
  }
  for (let left = 0; left < roots.length; left += 1)
    for (let right = left + 1; right < roots.length; right += 1) {
      for (const [from, to] of [
        [roots[left], roots[right]],
        [roots[right], roots[left]],
      ]) {
        const relative = path.relative(from, to);
        assert.ok(
          relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
          "Universal roots must be disjoint",
        );
      }
    }
}

async function captureUniversalDirectory(root) {
  await assertDirectory(root);
  assert.equal(
    await fs.realpath(root),
    root,
    "Universal directory must be canonical",
  );
  const chain = [];
  let current = path.parse(root).root;
  for (const component of [
    "",
    ...path.relative(current, root).split(path.sep).filter(Boolean),
  ]) {
    current = path.join(current, component);
    const status = await fs.lstat(current);
    assert.ok(
      status.isDirectory() && !status.isSymbolicLink(),
      "Universal directory fence requires real directories",
    );
    assert.ok(
      status.uid === 0 || status.uid === process.getuid(),
      "Universal directory ancestry must be owned",
    );
    assert.equal(
      status.mode & 0o022,
      0,
      "Universal directory ancestry must not be shared writable",
    );
    chain.push({
      path: current,
      dev: status.dev,
      ino: status.ino,
      uid: status.uid,
      mode: status.mode,
    });
  }
  assert.equal(
    chain.at(-1).uid,
    process.getuid(),
    "Universal output directory must be owned",
  );
  const check = async () => {
    for (const captured of chain) {
      const status = await fs.lstat(captured.path);
      assert.ok(
        status.isDirectory() && !status.isSymbolicLink(),
        "Universal directory fence was substituted",
      );
      for (const key of ["dev", "ino", "uid", "mode"])
        assert.equal(
          status[key],
          captured[key],
          "Universal directory fence changed",
        );
    }
  };
  Object.defineProperty(check, "root", { value: root });
  await check();
  return check;
}

async function createUniversalOutput(root, parentFence) {
  parentFence ??= await captureUniversalDirectory(path.dirname(root));
  assert.equal(path.dirname(root), parentFence.root);
  await parentFence();
  await fs.mkdir(root, { mode: 0o700 });
  await parentFence();
  return captureUniversalDirectory(root);
}

async function writeUniversalFile(filename, contents, mode, parentFence) {
  assert.equal(path.dirname(filename), parentFence.root);
  await parentFence();
  const handle = await fs.open(
    filename,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    await parentFence();
    const before = await handle.stat();
    assert.ok(
      before.isFile() && before.nlink === 1 && before.uid === process.getuid(),
      "Universal output must be an owned exclusive regular file",
    );
    sameFile(before, await fs.lstat(filename));
    await handle.writeFile(contents);
    await parentFence();
    const after = await handle.stat();
    for (const key of ["dev", "ino", "uid", "mode", "nlink"])
      assert.equal(
        after[key],
        before[key],
        "Universal output file changed identity",
      );
    assert.equal(after.size, Buffer.byteLength(contents));
    sameFile(after, await fs.lstat(filename));
    await parentFence();
  } finally {
    await handle.close();
  }
}

async function readUniversalArchives(value, repositoryRoot) {
  const inputs = exactObservation(
    value,
    universalArchitectures,
    "Electron archives",
  );
  const observations = {};
  const checksums =
    repositoryRoot === undefined
      ? null
      : JSON.parse(
          await fs.readFile(
            path.join(repositoryRoot, "node_modules/electron/checksums.json"),
            "utf8",
          ),
        );
  for (const architecture of universalArchitectures) {
    const row = exactObservation(
      inputs[architecture],
      ["directory", "filename", "sha256", "bytes"],
      "Electron archive",
    );
    await assertDirectory(row.directory);
    assert.equal(row.filename, `electron-v44.10.0-darwin-${architecture}.zip`);
    const measurement = measuredFields(row);
    assert.deepEqual(
      await measureRegularFile(path.join(row.directory, row.filename)),
      measurement,
      "Electron archive differs from retained observation",
    );
    if (checksums !== null)
      assert.equal(
        measurement.sha256,
        checksums[row.filename],
        "Electron archive differs from installed checksum pin",
      );
    observations[architecture] = {
      directory: row.directory,
      filename: row.filename,
      ...measurement,
    };
  }
  assert.equal(
    observations.arm64.directory,
    observations.x64.directory,
    "Both verified Electron archives must occupy the explicit selected directory",
  );
  return observations;
}

export async function selectExistingUniversalElectronArchives({
  repositoryRoot,
  electronVersion,
  directory,
}) {
  await assertDirectory(directory);
  const archives = {};
  for (const architecture of universalArchitectures) {
    archives[architecture] = await selectExistingElectronArchive({
      repositoryRoot,
      electronVersion,
      platform: "darwin",
      architecture,
      directory,
    });
  }
  // Check both official archive pins before parsing either ZIP inventory.
  for (const architecture of universalArchitectures)
    await readSnapshotArchive(archives[architecture], architecture);
  return archives;
}

// Only these reviewed Electron resources may differ between the two ZIPs.
// No archive entries are extracted and no general differing-.bin exemption is used.
const electronSnapshotPaths = Object.freeze({
  arm64:
    "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/v8_context_snapshot.arm64.bin",
  x64: "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/v8_context_snapshot.x86_64.bin",
});

async function readSnapshotArchive(archive, architecture) {
  const filename = path.join(archive.directory, archive.filename);
  const before = await fs.lstat(filename);
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const read = async (offset, length) => {
    assert.ok(
      Number.isSafeInteger(offset) &&
        Number.isSafeInteger(length) &&
        offset >= 0 &&
        length >= 0 &&
        offset <= before.size - length,
      "ZIP range is out of bounds",
    );
    const bytes = Buffer.alloc(length);
    let consumed = 0;
    while (consumed < length) {
      const result = await handle.read(
        bytes,
        consumed,
        length - consumed,
        offset + consumed,
      );
      assert.ok(result.bytesRead > 0, "ZIP was truncated while reading");
      consumed += result.bytesRead;
    }
    return bytes;
  };
  try {
    sameFile(before, await handle.stat());
    const tailLength = Math.min(before.size, 65_557);
    const tail = await read(before.size - tailLength, tailLength);
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (
        tail.readUInt32LE(index) === 0x06054b50 &&
        index + 22 + tail.readUInt16LE(index + 20) === tail.length
      ) {
        assert.equal(end, -1, "Ambiguous ZIP end record");
        end = index;
      }
    }
    assert.ok(end >= 0, "ZIP end record is missing");
    assert.equal(tail.readUInt16LE(end + 4), 0, "Multidisk ZIP is unsupported");
    assert.equal(tail.readUInt16LE(end + 6), 0, "Multidisk ZIP is unsupported");
    const count = tail.readUInt16LE(end + 10);
    assert.equal(tail.readUInt16LE(end + 8), count);
    assert.ok(count > 0 && count < 65_535, "ZIP64 or empty ZIP is unsupported");
    const size = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    assert.ok(
      size <= 16 * 1024 * 1024 &&
        offset + size === before.size - tailLength + end,
      "Invalid ZIP central-directory extent",
    );
    const directory = await read(offset, size);
    const entries = new Map();
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      assert.ok(
        cursor <= directory.length - 46,
        "Truncated ZIP central record",
      );
      assert.equal(directory.readUInt32LE(cursor), 0x02014b50);
      const nameBytes = directory.readUInt16LE(cursor + 28);
      const extraBytes = directory.readUInt16LE(cursor + 30);
      const commentBytes = directory.readUInt16LE(cursor + 32);
      const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
      assert.ok(next <= directory.length, "Truncated ZIP entry name");
      const nameBuffer = directory.subarray(
        cursor + 46,
        cursor + 46 + nameBytes,
      );
      const name = nameBuffer.toString("utf8");
      assert.ok(
        Buffer.from(name).equals(nameBuffer),
        "Invalid ZIP filename encoding",
      );
      observationPath(name.endsWith("/") ? name.slice(0, -1) : name);
      assert.equal(entries.has(name), false, "Duplicate ZIP entry");
      assert.equal(
        directory.readUInt16LE(cursor + 34),
        0,
        "Multidisk ZIP entry",
      );
      const entry = {
        name,
        flags: directory.readUInt16LE(cursor + 8),
        method: directory.readUInt16LE(cursor + 10),
        crc: directory.readUInt32LE(cursor + 16),
        compressed: directory.readUInt32LE(cursor + 20),
        bytes: directory.readUInt32LE(cursor + 24),
        offset: directory.readUInt32LE(cursor + 42),
        unixMode: directory.readUInt32LE(cursor + 38) >>> 16,
        createSystem: directory[cursor + 5],
      };
      assert.ok(
        entry.offset < offset,
        "ZIP local entry overlaps central directory",
      );
      entries.set(name, entry);
      cursor = next;
    }
    assert.equal(
      cursor,
      directory.length,
      "Trailing ZIP central-directory bytes",
    );
    const snapshots = [...entries.values()].filter((entry) =>
      entry.name.endsWith(".bin"),
    );
    assert.deepEqual(
      snapshots.map((entry) => entry.name),
      [electronSnapshotPaths[architecture]],
      "Electron ZIP must contain exactly its reviewed snapshot .bin path",
    );
    const rows = [];
    for (const entry of snapshots.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      assert.equal(
        entry.createSystem,
        3,
        "Snapshot ZIP entry requires Unix metadata",
      );
      assert.equal(
        entry.unixMode & 0o170000,
        0o100000,
        "Snapshot ZIP entry must be a regular file",
      );
      assert.equal(entry.flags & 1, 0, "Encrypted ZIP entry is unsupported");
      assert.ok(
        [0, 8].includes(entry.method),
        "Unsupported ZIP compression method",
      );
      assert.ok(
        entry.bytes > 0 &&
          entry.bytes <= 64 * 1024 * 1024 &&
          entry.compressed <= 64 * 1024 * 1024,
        "Snapshot ZIP entry is oversized",
      );
      const local = await read(entry.offset, 30);
      assert.equal(local.readUInt32LE(0), 0x04034b50);
      assert.equal(local.readUInt16LE(6), entry.flags);
      assert.equal(local.readUInt16LE(8), entry.method);
      const localNameBytes = local.readUInt16LE(26);
      const localExtraBytes = local.readUInt16LE(28);
      assert.equal(
        (await read(entry.offset + 30, localNameBytes)).toString("utf8"),
        entry.name,
      );
      const dataOffset = entry.offset + 30 + localNameBytes + localExtraBytes;
      assert.ok(
        dataOffset + entry.compressed <= offset,
        "Snapshot data overlaps ZIP central directory",
      );
      const compressed = await read(dataOffset, entry.compressed);
      const contents =
        entry.method === 0
          ? compressed
          : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
      assert.equal(
        contents.length,
        entry.bytes,
        "Snapshot decompression size mismatch",
      );
      assert.equal(
        crc32(contents),
        entry.crc,
        "Snapshot ZIP CRC disagrees with contents",
      );
      rows.push({
        archivePath: entry.name,
        sha256: digest(contents),
        bytes: contents.length,
      });
    }
    sameFile(before, await handle.stat());
    sameFile(before, await fs.lstat(filename));
    return rows;
  } finally {
    await handle.close();
  }
}

async function inspectUniversalAsar(paths, common, expectedBuildIdentity) {
  const archivePath = path.join(paths.resourcesDirectory, "app.asar");
  const archive = await measureRegularFile(archivePath);
  uncache(archivePath);
  const entries = listPackage(archivePath)
    .map((name) => {
      assert.ok(name.startsWith("/"));
      const relativePath = observationPath(name.slice(1));
      const entry = statFile(archivePath, relativePath, false);
      assert.equal("link" in entry, false, "ASAR must not contain links");
      return {
        path: relativePath,
        directory: "files" in entry,
        unpacked: entry.unpacked === true,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assert.deepEqual(
    entries.filter((row) => row.directory).map((row) => row.path),
    ["dist", "dist/calculator", "dist/native"],
  );
  assert.deepEqual(
    entries.filter((row) => !row.directory).map((row) => row.path),
    [
      ...expectedDesktopDistributionFiles("darwin").map(
        (name) => `dist/${name}`,
      ),
      "package.json",
    ].sort(),
    "Universal ASAR inventory differs from the fixed runtime layout",
  );
  assert.deepEqual(
    entries
      .filter((row) => !row.directory && row.unpacked)
      .map((row) => row.path),
    nativeDistributionFiles.map((name) => `dist/${name}`),
    "Only fixed native addons may be unpacked",
  );
  const unpackedRoot = path.join(paths.resourcesDirectory, "app.asar.unpacked");
  const unpacked = await inspectArtifactTree(unpackedRoot, {
    allowSymlinks: false,
  });
  assert.deepEqual(
    unpacked.entries.map((row) => row.path),
    [
      "dist",
      "dist/native",
      ...nativeDistributionFiles.map((name) => `dist/${name}`),
    ],
  );
  for (const row of common.files) {
    const contents = extractFile(archivePath, `dist/${row.path}`, false);
    assert.deepEqual(
      { sha256: digest(contents), bytes: contents.length },
      { sha256: row.sha256, bytes: row.bytes },
      "Common runtime bytes changed during universal merge",
    );
  }
  const identity = inspectBuildIdentityAsset(
    extractFile(archivePath, "dist/build-identity.json", false),
    expectedBuildIdentity,
  );
  const metadata = exactObservation(
    JSON.parse(
      extractFile(archivePath, "package.json", false).toString("utf8"),
    ),
    ["main", "name", "productName", "type", "version"],
    "Packaged metadata",
  );
  assert.deepEqual(
    { ...metadata, version: undefined },
    {
      main: "dist/main.js",
      name: packagedExecutableName,
      productName: appName,
      type: "module",
      version: undefined,
    },
  );
  assert.match(
    metadata.version,
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/,
  );
  return {
    archive,
    archivePath,
    unpackedRoot,
    buildIdentity: identity,
    packageVersion: metadata.version,
  };
}

function verifyPreFuseHistory(value, nativeSlices) {
  return exactRows(value, 2, "Pre-fuse native artifacts").map((row, index) => {
    const observation = retainedUniversalMachO(
      row,
      `dist/${nativeDistributionFiles[index]}`,
    );
    for (const architecture of universalArchitectures) {
      const thin = nativeSlices[architecture].artifacts[index];
      const retained = observation.slices[architecture];
      assert.equal(
        retained.sha256,
        thin.sha256,
        "Retained pre-fuse native history differs from compiler output",
      );
      assert.equal(
        retained.bytes,
        thin.bytes,
        "Retained pre-fuse native length differs from compiler output",
      );
    }
    return observation;
  });
}

async function inspectMergedNative(paths) {
  const root = path.join(paths.resourcesDirectory, "app.asar.unpacked");
  return Promise.all(
    nativeDistributionFiles.map(async (name) => {
      const relativePath = `dist/${name}`;
      await assertDirectory(path.dirname(path.join(root, relativePath)));
      const { contents } = await measureRegularFile(
        path.join(root, relativePath),
        true,
      );
      return universalMachO(contents, relativePath, 8);
    }),
  );
}

async function inspectMachOTree(root, tree) {
  const observations = [];
  const magicNumbers = [
    0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca, 0xfeedface, 0xcefaedfe,
    0xfeedfacf, 0xcffaedfe,
  ];
  for (const entry of tree.entries.filter((row) => row.type === "file")) {
    const filename = path.join(root, entry.path);
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const prefix = Buffer.alloc(4);
    let count;
    try {
      count = (await handle.read(prefix, 0, 4, 0)).bytesRead;
    } finally {
      await handle.close();
    }
    if (count === 4 && magicNumbers.includes(prefix.readUInt32BE(0))) {
      const { contents, ...measurement } = await measureRegularFile(
        filename,
        true,
      );
      assert.equal(
        measurement.sha256,
        entry.sha256,
        "Mach-O changed after tree inspection",
      );
      assert.equal(measurement.bytes, entry.bytes);
      observations.push(universalMachO(contents, entry.path));
    }
  }
  return observations;
}

async function inspectSnapshotResources(archives, tree) {
  const result = {};
  for (const architecture of universalArchitectures) {
    const rows = await readSnapshotArchive(
      archives[architecture],
      architecture,
    );
    result[architecture] = rows.map((row) => {
      assert.ok(row.archivePath.startsWith("Electron.app/"));
      const relativePath = row.archivePath.slice("Electron.app/".length);
      const final = tree.entries.find((entry) => entry.path === relativePath);
      assert.equal(
        final?.type,
        "file",
        "Final Electron snapshot resource is missing",
      );
      assert.equal(
        final.sha256,
        row.sha256,
        "Final Electron snapshot differs from its architecture ZIP",
      );
      assert.equal(final.bytes, row.bytes);
      return { path: relativePath, ...row };
    });
  }
  const expectedPaths = [
    ...new Set(
      Object.values(result)
        .flat()
        .map((row) => row.path),
    ),
  ].sort();
  assert.deepEqual(
    tree.entries
      .filter((row) => row.type === "file" && row.path.endsWith(".bin"))
      .map((row) => row.path),
    expectedPaths,
    "Additional final .bin resources are forbidden",
  );
  return result;
}

export async function inspectUniversalDesktop({
  packageDirectory,
  expectedBuildIdentity,
  commonObservation: suppliedCommon,
  nativeSliceObservations,
  electronArchiveObservations,
  preFuseNativeArtifacts: suppliedPreFuse,
  temporaryRoot,
}) {
  expectedBuildIdentity = selectedUniversalIdentity(expectedBuildIdentity);
  const common = commonObservation(suppliedCommon, expectedBuildIdentity);
  const nativeSlices = await readNativeSlices(nativeSliceObservations);
  const preFuseNativeArtifacts = verifyPreFuseHistory(
    suppliedPreFuse,
    nativeSlices,
  );
  const electronArchives = await readUniversalArchives(
    electronArchiveObservations,
  );
  assertDisjointRoots([
    packageDirectory,
    temporaryRoot,
    ...universalArchitectures.map(
      (architecture) => nativeSlices[architecture].root,
    ),
    electronArchives.arm64.directory,
  ]);
  const paths = await desktopPackagePaths(packageDirectory, "darwin");
  const packageFence = await captureUniversalDirectory(paths.appBundle);
  const tree = await inspectArtifactTree(paths.appBundle);
  assert.deepEqual(
    tree.entries
      .filter((row) => row.type === "file" && row.path.endsWith(".asar"))
      .map((row) => row.path),
    ["Contents/Resources/app.asar"],
    "Universal app must contain exactly one ASAR",
  );
  assert.deepEqual(
    tree.entries
      .filter((row) => row.type === "file" && row.path.endsWith(".node"))
      .map((row) => row.path),
    nativeDistributionFiles.map(
      (name) => `Contents/Resources/app.asar.unpacked/dist/${name}`,
    ),
    "Universal app must contain exactly the two fixed native addons",
  );
  const asar = await inspectUniversalAsar(paths, common, expectedBuildIdentity);
  const nativeArtifacts = await inspectMergedNative(paths);
  const machOFiles = await inspectMachOTree(paths.appBundle, tree);
  const executablePath = path
    .relative(paths.appBundle, paths.executable)
    .split(path.sep)
    .join("/");
  const executable = machOFiles.find((row) => row.path === executablePath);
  assert.ok(executable, "Universal launcher is missing");
  const executableBytes = await measureRegularFile(paths.executable, true);
  universalMachO(executableBytes.contents, executablePath, 2);
  const framework = machOFiles.find(
    (row) => row.path === frameworkRelativePath,
  );
  assert.ok(framework, "Universal Electron framework is missing");
  const frameworkBytes = await measureRegularFile(
    path.join(paths.appBundle, frameworkRelativePath),
    true,
  );
  assert.equal(frameworkBytes.sha256, framework.sha256);
  universalMachO(frameworkBytes.contents, frameworkRelativePath, 6);
  for (const artifact of nativeArtifacts) {
    const relativePath = `Contents/Resources/app.asar.unpacked/${artifact.path}`;
    assert.deepEqual(
      machOFiles.find((row) => row.path === relativePath),
      { ...artifact, path: relativePath },
      "Final native artifact and complete Mach-O inventory disagree",
    );
  }
  const infoPlist = await measureRegularFile(
    path.join(paths.appBundle, "Contents/Info.plist"),
    true,
  );
  const plistValue = plist.parse(infoPlist.contents.toString("utf8"));
  assert.equal(
    plistValue.CFBundleVersion,
    asar.packageVersion,
    "Plist version differs from packaged version",
  );
  assert.equal(
    plistValue.CFBundleShortVersionString,
    asar.packageVersion,
    "Plist short version differs from packaged version",
  );
  const asarIntegrity = exactObservation(
    plistValue.ElectronAsarIntegrity,
    ["Resources/app.asar"],
    "ASAR integrity map",
  );
  const integrityValue = exactObservation(
    asarIntegrity["Resources/app.asar"],
    ["algorithm", "hash"],
    "ASAR integrity row",
  );
  assert.equal(integrityValue.algorithm, "SHA256");
  const header = getRawHeader(asar.archivePath);
  assert.equal(typeof header.headerString, "string");
  assert.equal(
    sha256(integrityValue.hash),
    digest(header.headerString),
    "Plist ASAR integrity does not match the final ASAR header",
  );
  const expectedDigest = digest(
    `Resources/app.asarSHA256${integrityValue.hash}`,
  );
  const integrity = {};
  const fuses = {};
  const temporaryFence = await createUniversalOutput(temporaryRoot);
  for (const architecture of universalArchitectures) {
    const slice = framework.slices[architecture];
    const thin = frameworkBytes.contents.subarray(
      slice.offset,
      slice.offset + slice.bytes,
    );
    const sentinel = thin.indexOf(integritySentinel);
    assert.ok(
      sentinel >= 0,
      `Missing ${architecture} framework integrity sentinel`,
    );
    assert.equal(
      thin.indexOf(integritySentinel, sentinel + 1),
      -1,
      "Ambiguous framework integrity sentinel",
    );
    const payload = sentinel + integritySentinel.length;
    assert.ok(
      payload <= thin.length - 34,
      "Truncated framework integrity payload",
    );
    assert.equal(thin[payload], 1, "Framework integrity is not enabled");
    assert.equal(
      thin[payload + 1],
      1,
      "Unsupported framework integrity version",
    );
    const observedDigest = thin
      .subarray(payload + 2, payload + 34)
      .toString("hex");
    assert.equal(
      observedDigest,
      expectedDigest,
      `${architecture} framework integrity digest disagrees with final ASAR`,
    );
    integrity[architecture] = {
      algorithm: "SHA256",
      expectedDigest,
      observedDigest,
    };
    const thinPath = path.join(temporaryRoot, `framework-${architecture}.bin`);
    await packageFence();
    await writeUniversalFile(thinPath, thin, 0o600, temporaryFence);
    fuses[architecture] = await verifyPackagedElectronFuses(thinPath);
    await temporaryFence();
    await packageFence();
    assert.deepEqual(
      fuses[architecture],
      disabledFuseObservation,
      `${architecture} framework fuses are not all disabled`,
    );
    assert.deepEqual(
      await measureRegularFile(thinPath),
      { sha256: slice.sha256, bytes: slice.bytes },
      "Fuse readback changed its owned thin copy",
    );
  }
  const snapshotResources = await inspectSnapshotResources(
    electronArchives,
    tree,
  );
  const measurements = {
    executable: {
      path: executablePath,
      sha256: executable.sha256,
      bytes: executable.bytes,
      architecture: "universal",
    },
    asar: { path: "Contents/Resources/app.asar", ...asar.archive },
    infoPlist: {
      path: "Contents/Info.plist",
      sha256: infoPlist.sha256,
      bytes: infoPlist.bytes,
    },
  };
  for (const row of [...Object.values(measurements), ...machOFiles]) {
    const entry = tree.entries.find((entry) => entry.path === row.path);
    assert.equal(entry?.type, "file");
    assert.equal(
      entry.sha256,
      row.sha256,
      "Universal tree and observations disagree",
    );
    assert.equal(entry.bytes, row.bytes);
  }
  assert.deepEqual(
    await measureRegularFile(asar.archivePath),
    asar.archive,
    "Final ASAR changed during inspection",
  );
  assert.deepEqual(
    await readNativeSlices(nativeSlices),
    nativeSlices,
    "Compiler outputs changed during inspection",
  );
  assert.deepEqual(
    await readUniversalArchives(electronArchives),
    electronArchives,
    "Electron archives changed during inspection",
  );
  assert.deepEqual(
    await inspectArtifactTree(paths.appBundle),
    tree,
    "Universal app changed during inspection",
  );
  await temporaryFence();
  await packageFence();
  return {
    schemaVersion: 1,
    kind: "unsigned-universal-app-inventory",
    ...paths,
    platform: "darwin",
    architecture: "universal",
    buildIdentity: asar.buildIdentity,
    packageVersion: asar.packageVersion,
    nativeArtifacts,
    fuses,
    measurements,
    tree,
    composition: {
      common,
      electronArchives,
      nativeSlices,
      preFuseNativeArtifacts,
      machOFiles,
      snapshotResources,
      integrity,
    },
  };
}

export async function packageUnsignedUniversalDesktop({
  repositoryRoot,
  commonRoot,
  nativeSlices: suppliedNative,
  electronArchives: suppliedArchives,
  stageRoot,
  outputRoot,
  temporaryRoot,
  electronVersion,
  expectedBuildIdentity,
}) {
  expectedBuildIdentity = selectedUniversalIdentity(expectedBuildIdentity);
  assert.equal(
    process.platform,
    "darwin",
    "Universal packaging requires macOS",
  );
  assert.equal(
    electronVersion,
    "44.10.0",
    "Universal packaging requires the reviewed Electron version",
  );
  const version = await readWorkspaceVersion(repositoryRoot);
  const common = await inspectDesktopCommon({
    commonRoot,
    expectedBuildIdentity,
  });
  const nativeSlices = await readNativeSlices(suppliedNative);
  const electronArchives = await readUniversalArchives(
    suppliedArchives,
    repositoryRoot,
  );
  assertDisjointRoots([
    commonRoot,
    stageRoot,
    outputRoot,
    temporaryRoot,
    ...universalArchitectures.map(
      (architecture) => nativeSlices[architecture].root,
    ),
    electronArchives.arm64.directory,
  ]);
  const stageFence = await createUniversalOutput(stageRoot);
  const outputFence = await createUniversalOutput(outputRoot);
  const temporaryFence = await createUniversalOutput(temporaryRoot);
  const commonFence = await copyDesktopCommon(
    commonRoot,
    path.join(stageRoot, "dist"),
    common,
    stageFence,
  );
  const checkOutputRoots = async () => {
    await stageFence();
    await outputFence();
    await temporaryFence();
    await commonFence();
  };
  assert.deepEqual(
    await inspectDesktopCommon({
      commonRoot: path.join(stageRoot, "dist"),
      expectedBuildIdentity,
    }),
    common,
    "Staged common files changed",
  );
  await writeUniversalFile(
    path.join(stageRoot, "package.json"),
    `${JSON.stringify({ main: "dist/main.js", name: packagedExecutableName, private: true, productName: appName, type: "module", version }, null, 2)}\n`,
    0o600,
    stageFence,
  );
  const entered = new Set();
  const hookPaths = new Set();
  const completed = new Map();
  const hookWork = [];
  let acceptingHooks = true;
  const afterCopy = (value) => {
    const work = (async () => {
      assert.equal(
        acceptingHooks,
        true,
        "afterCopy arrived after packager settlement",
      );
      const hook = exactObservation(
        value,
        ["buildPath", "electronVersion", "platform", "arch"],
        "Universal afterCopy hook",
      );
      assert.ok(
        universalArchitectures.includes(hook.arch),
        "Unexpected afterCopy architecture",
      );
      assert.equal(hook.platform, "darwin");
      assert.equal(hook.electronVersion, electronVersion);
      assert.equal(
        entered.has(hook.arch),
        false,
        "Duplicate afterCopy architecture",
      );
      entered.add(hook.arch);
      await checkOutputRoots();
      await assertDirectory(hook.buildPath);
      assert.match(
        path.relative(temporaryRoot, hook.buildPath),
        /^electron-packager\/tmp-[^/]+\/Electron\.app\/Contents\/Resources\/app$/,
        "Unexpected afterCopy build path",
      );
      assert.equal(
        hookPaths.has(hook.buildPath),
        false,
        "Duplicate afterCopy build path",
      );
      hookPaths.add(hook.buildPath);
      const hookFence = await captureUniversalDirectory(hook.buildPath);
      const hookDistFence = await captureUniversalDirectory(
        path.join(hook.buildPath, "dist"),
      );
      assert.deepEqual(
        await inspectDesktopCommon({
          commonRoot: path.join(hook.buildPath, "dist"),
          expectedBuildIdentity,
        }),
        common,
        "Per-architecture common files changed",
      );
      const slice = nativeSlices[hook.arch];
      await hookFence();
      await hookDistFence();
      assert.deepEqual(
        (await readNativeSlices(nativeSlices))[hook.arch],
        slice,
        "Native input changed before afterCopy",
      );
      const nativeFence = await createUniversalOutput(
        path.join(hook.buildPath, "dist/native"),
        hookDistFence,
      );
      for (const [index, name] of nativeDistributionFiles.entries()) {
        const { contents, ...measurement } = await measureRegularFile(
          path.join(slice.root, path.basename(name)),
          true,
        );
        assert.deepEqual(
          measurement,
          {
            sha256: slice.artifacts[index].sha256,
            bytes: slice.artifacts[index].bytes,
          },
          "Native file changed before copying",
        );
        inspectMachOHeader(contents, hook.arch);
        await hookFence();
        await writeUniversalFile(
          path.join(hook.buildPath, "dist", name),
          contents,
          0o600,
          nativeFence,
        );
      }
      const distribution = await inspectDesktopDistribution({
        distributionRoot: path.join(hook.buildPath, "dist"),
        platform: "darwin",
        architecture: hook.arch,
        expectedBuildIdentity,
      });
      assert.deepEqual(
        distribution.files.filter(
          (row) => !nativeDistributionFiles.includes(row.path),
        ),
        common.files,
        "afterCopy changed common files",
      );
      assert.deepEqual(
        distribution.nativeArtifacts,
        slice.artifacts,
        "afterCopy swapped native architecture bytes",
      );
      await hookFence();
      await hookDistFence();
      await nativeFence();
      await checkOutputRoots();
      completed.set(hook.arch, distribution);
    })();
    hookWork.push(work);
    return work;
  };
  let directories;
  let hookResults;
  await checkOutputRoots();
  try {
    directories = await packager({
      arch: "universal",
      asar: { unpack: "{aac-protection,durable-record}.node" },
      osxUniversal: { mergeASARs: true },
      afterCopy: [afterCopy],
      dir: stageRoot,
      electronVersion,
      electronZipDir: electronArchives.arm64.directory,
      executableName: packagedExecutableName,
      name: appName,
      osxSign: false,
      out: outputRoot,
      tmpdir: temporaryRoot,
      overwrite: false,
      platform: "darwin",
      prune: false,
      quiet: true,
    });
  } finally {
    // Retain and drain every hook promise we observed, even if the public
    // packager rejects before its other architecture callback completes.
    acceptingHooks = false;
    hookResults = await Promise.allSettled(hookWork);
    await checkOutputRoots();
  }
  assert.ok(
    hookResults.every((result) => result.status === "fulfilled"),
    "A universal afterCopy hook failed",
  );
  assert.deepEqual(
    [...completed.keys()].sort(),
    [...universalArchitectures].sort(),
    "Both afterCopy architectures must finish",
  );
  assert.equal(directories.length, 1);
  const packageDirectory = path.resolve(directories[0]);
  assert.equal(
    path.dirname(packageDirectory),
    outputRoot,
    "Unexpected universal package output",
  );
  const paths = await desktopPackagePaths(packageDirectory, "darwin");
  const packageFence = await captureUniversalDirectory(paths.appBundle);
  // This measurement is deliberately taken before whole-app ad-hoc repair.
  // It cannot be reconstructed from the final signed native bytes on resume.
  const preFuseNativeArtifacts = verifyPreFuseHistory(
    await inspectMergedNative(paths),
    nativeSlices,
  );
  await checkOutputRoots();
  await packageFence();
  await hardenPackagedElectron(paths.executable, "darwin", "universal");
  await packageFence();
  await checkOutputRoots();
  const result = await inspectUniversalDesktop({
    packageDirectory,
    expectedBuildIdentity,
    commonObservation: common,
    nativeSliceObservations: nativeSlices,
    electronArchiveObservations: electronArchives,
    preFuseNativeArtifacts,
    temporaryRoot: path.join(temporaryRoot, "inspection"),
  });
  assert.equal(
    result.packageVersion,
    version,
    "Universal packager changed the workspace version",
  );
  assert.deepEqual(
    await inspectDesktopCommon({ commonRoot, expectedBuildIdentity }),
    common,
    "Common inputs changed during packaging",
  );
  assert.deepEqual(
    await readNativeSlices(nativeSlices),
    nativeSlices,
    "Native inputs changed during packaging",
  );
  assert.deepEqual(
    await readUniversalArchives(electronArchives, repositoryRoot),
    electronArchives,
    "Electron archives changed during packaging",
  );
  await packageFence();
  await checkOutputRoots();
  return result;
}
