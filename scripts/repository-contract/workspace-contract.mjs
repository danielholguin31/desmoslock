import fs from "node:fs";
import path from "node:path";

import { fail, readJson } from "./shared.mjs";

const expectedWorkspaces = [
  "apps/desktop",
  "apps/web",
  "packages/contracts",
  "packages/domain",
  "packages/test-support",
];
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const productionWorkspaces = expectedWorkspaces.filter(
  (workspace) => workspace !== "packages/test-support",
);
const forbiddenProductionPatterns = [
  ["arbitrary backend URL", /\bserverUrl\b|\ballowServer\b/],
  ["legacy LAN origin", /localhost:4000|127\.0\.0\.1:4000/],
  ["Linux package", /\bAppImage\b|--linux\b/],
  ["manual licensing", /manual[- ]licen[sc]/i],
  ["quote intake", /\bquote_requests\b|\bquote form\b/i],
  ["test support import", /@desmoslock\/test-support/],
];

function walkFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...walkFiles(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

function internalDependencyEntries(manifest) {
  return dependencySections.flatMap((section) =>
    Object.entries(manifest[section] ?? {})
      .filter(([dependency]) => dependency.startsWith("@desmoslock/"))
      .map(([dependency, version]) => ({ dependency, section, version })),
  );
}

function verifyInternalDependencyVersions(
  manifest,
  label,
  knownInternalPackages,
  rootVersion,
) {
  for (const { dependency, section, version } of internalDependencyEntries(
    manifest,
  )) {
    if (!knownInternalPackages.has(dependency)) {
      fail(`${label} references unknown internal package ${dependency}`);
    }
    if (version !== rootVersion) {
      fail(
        `${label} ${section} ${dependency}@${version} differs from root ${rootVersion}`,
      );
    }
  }
}

function verifyLockedInternalDependencies(manifest, lockedManifest, label) {
  for (const { dependency, section, version } of internalDependencyEntries(
    manifest,
  )) {
    if (lockedManifest?.[section]?.[dependency] !== version) {
      fail(
        `${label} lockfile ${section} ${dependency} differs from its manifest`,
      );
    }
  }
}

export function verifyWorkspaceContract(repositoryRoot) {
  const rootPackage = readJson(repositoryRoot, "package.json");
  if (
    JSON.stringify(rootPackage.workspaces) !==
    JSON.stringify(["apps/*", "packages/*"])
  ) {
    fail("Root workspaces must include only apps/* and packages/*");
  }
  for (const legacyDirectory of ["desktop", "server", "web"]) {
    if (
      rootPackage.workspaces.some((workspace) =>
        workspace.includes(legacyDirectory),
      )
    ) {
      fail(`Legacy ${legacyDirectory} must not be an npm workspace`);
    }
  }

  const workspacePaths = expectedWorkspaces.filter((workspace) =>
    fs.existsSync(path.join(repositoryRoot, workspace, "package.json")),
  );
  if (JSON.stringify(workspacePaths) !== JSON.stringify(expectedWorkspaces)) {
    fail(`Workspace inventory differs: ${workspacePaths.join(", ")}`);
  }

  const rootVersion = rootPackage.version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(rootVersion)) {
    fail(`Root version must be strict stable SemVer: ${rootVersion}`);
  }

  const workspaceManifests = new Map(
    expectedWorkspaces.map((workspace) => [
      workspace,
      readJson(repositoryRoot, `${workspace}/package.json`),
    ]),
  );
  const workspaceByPackageName = new Map(
    [...workspaceManifests].map(([workspace, manifest]) => [
      manifest.name,
      workspace,
    ]),
  );
  if (workspaceByPackageName.size !== expectedWorkspaces.length) {
    fail("Every v2 workspace must have a unique package name");
  }

  verifyInternalDependencyVersions(
    rootPackage,
    "Root manifest",
    workspaceByPackageName,
    rootVersion,
  );

  for (const workspace of expectedWorkspaces) {
    const manifest = workspaceManifests.get(workspace);
    if (manifest.version !== rootVersion) {
      fail(
        `${workspace} version ${manifest.version} differs from root ${rootVersion}`,
      );
    }
    if (manifest.private !== true) fail(`${workspace} must remain private`);
    if (
      manifest.scripts?.publish !== undefined ||
      manifest.scripts?.prepublishOnly !== undefined
    ) {
      fail(`${workspace} must not expose a publication script`);
    }

    verifyInternalDependencyVersions(
      manifest,
      workspace,
      workspaceByPackageName,
      rootVersion,
    );
  }

  for (const workspace of productionWorkspaces) {
    const manifest = readJson(repositoryRoot, `${workspace}/package.json`);
    if (
      internalDependencyEntries(manifest).some(
        ({ dependency }) => dependency === "@desmoslock/test-support",
      )
    ) {
      fail(`${workspace} depends on test-only support`);
    }

    for (const sourceRoot of ["src", "dist"]) {
      const absoluteRoot = path.join(repositoryRoot, workspace, sourceRoot);
      if (!fs.existsSync(absoluteRoot)) {
        continue;
      }
      for (const file of walkFiles(absoluteRoot)) {
        const contents = fs.readFileSync(file, "utf8");
        for (const [label, pattern] of forbiddenProductionPatterns) {
          if (pattern.test(contents)) {
            fail(
              `${path.relative(repositoryRoot, file)} contains forbidden ${label}`,
            );
          }
        }
      }
    }
  }

  const testSupport = readJson(
    repositoryRoot,
    "packages/test-support/package.json",
  );
  if (
    testSupport.exports?.["."]?.["desmoslock-test"] !== "./dist/index.js" ||
    testSupport.exports?.["."]?.default !== "./dist/blocked.js"
  ) {
    fail(
      "Test support must expose implementation only through desmoslock-test",
    );
  }

  for (const workspaceRoot of ["apps", "packages"]) {
    const nestedLockfiles = walkFiles(
      path.join(repositoryRoot, workspaceRoot),
    ).filter((file) => path.basename(file) === "package-lock.json");
    if (nestedLockfiles.length > 0) {
      fail(
        `v2 workspaces must use only the root lockfile: ${nestedLockfiles
          .map((file) => path.relative(repositoryRoot, file))
          .join(", ")}`,
      );
    }
  }

  for (const forbiddenScript of [
    "app",
    "dev",
    "dist",
    "publish:installers",
    "server",
  ]) {
    if (rootPackage.scripts?.[forbiddenScript] !== undefined) {
      fail(
        `Root manifest restores forbidden legacy script: ${forbiddenScript}`,
      );
    }
  }

  const lockfile = readJson(repositoryRoot, "package-lock.json");
  if (
    lockfile.packages?.[""]?.name !== rootPackage.name ||
    lockfile.packages?.[""]?.version !== rootVersion
  ) {
    fail("Root lockfile name/version differs from package.json");
  }
  verifyLockedInternalDependencies(
    rootPackage,
    lockfile.packages?.[""],
    "Root",
  );
  for (const [workspace, manifest] of workspaceManifests) {
    const lockedWorkspace = lockfile.packages?.[workspace];
    if (
      lockedWorkspace?.name !== manifest.name ||
      lockedWorkspace?.version !== rootVersion
    ) {
      fail(`${workspace} lockfile name/version differs from its manifest`);
    }

    verifyLockedInternalDependencies(manifest, lockedWorkspace, workspace);

    const internalLink = lockfile.packages?.[`node_modules/${manifest.name}`];
    if (internalLink?.link !== true || internalLink?.resolved !== workspace) {
      fail(`${manifest.name} lockfile link does not resolve to ${workspace}`);
    }
  }
  const lockWorkspaces = Object.keys(lockfile.packages)
    .filter((entry) => entry !== "" && lockfile.packages[entry]?.link !== true)
    .filter((entry) => expectedWorkspaces.includes(entry))
    .sort();
  if (
    JSON.stringify(lockWorkspaces) !==
    JSON.stringify([...expectedWorkspaces].sort())
  ) {
    fail(`Lockfile workspace inventory differs: ${lockWorkspaces.join(", ")}`);
  }
}
