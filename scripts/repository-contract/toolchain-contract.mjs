import path from "node:path";

import { fail, readJson, readText } from "./shared.mjs";

export const expectedToolchain = Object.freeze({
  node: "24.20.0",
  npm: "11.12.1",
  nodeTypes: "24.13.3",
  supabaseClient: "2.115.0",
});

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const workspacePaths = [
  "apps/desktop",
  "apps/web",
  "packages/contracts",
  "packages/domain",
  "packages/test-support",
];

function directDependencyReferences(manifest, dependency) {
  return dependencySections.flatMap((section) =>
    manifest[section]?.[dependency] === undefined
      ? []
      : [{ section, version: manifest[section][dependency] }],
  );
}

export function assertToolchainManifestContract({
  lockfile,
  nodeVersion,
  rootPackage,
  workspacePackages,
}) {
  if (nodeVersion.trim() !== expectedToolchain.node) {
    fail(`.node-version must pin Node.js ${expectedToolchain.node}`);
  }
  if (rootPackage.engines?.node !== expectedToolchain.node) {
    fail(`Root Node.js engine must pin ${expectedToolchain.node}`);
  }
  if (rootPackage.packageManager !== `npm@${expectedToolchain.npm}`) {
    fail(`Root packageManager must pin npm ${expectedToolchain.npm}`);
  }
  if (
    rootPackage.devDependencies?.["@types/node"] !== expectedToolchain.nodeTypes
  ) {
    fail(`Root @types/node must pin ${expectedToolchain.nodeTypes}`);
  }

  const directSupabaseClients = [
    ["root", rootPackage],
    ...Object.entries(workspacePackages),
  ].flatMap(([workspace, manifest]) =>
    directDependencyReferences(manifest, "@supabase/supabase-js").map(
      ({ section, version }) => ({ section, version, workspace }),
    ),
  );
  const expectedSupabaseClients = [
    {
      section: "dependencies",
      version: expectedToolchain.supabaseClient,
      workspace: "apps/web",
    },
  ];
  if (
    JSON.stringify(directSupabaseClients) !==
    JSON.stringify(expectedSupabaseClients)
  ) {
    fail(
      `Only apps/web may depend directly on @supabase/supabase-js@${expectedToolchain.supabaseClient}`,
    );
  }

  if (lockfile.packages?.[""]?.engines?.node !== expectedToolchain.node) {
    fail("Root lockfile Node.js engine differs from package.json");
  }
  if (
    lockfile.packages?.[""]?.devDependencies?.["@types/node"] !==
    expectedToolchain.nodeTypes
  ) {
    fail("Root lockfile @types/node differs from package.json");
  }
  if (
    lockfile.packages?.["apps/web"]?.dependencies?.["@supabase/supabase-js"] !==
    expectedToolchain.supabaseClient
  ) {
    fail("Web lockfile @supabase/supabase-js differs from package.json");
  }
  if (
    lockfile.packages?.["node_modules/@types/node"]?.version !==
    expectedToolchain.nodeTypes
  ) {
    fail(`Lockfile must resolve @types/node ${expectedToolchain.nodeTypes}`);
  }
  if (
    lockfile.packages?.["node_modules/@supabase/supabase-js"]?.version !==
    expectedToolchain.supabaseClient
  ) {
    fail(
      `Lockfile must resolve @supabase/supabase-js ${expectedToolchain.supabaseClient}`,
    );
  }
}

export function assertWorkflowToolchain(workflow, label, expectedJobCount) {
  const exactSetup = new RegExp(
    [
      "^ {6}- uses: actions/setup-node@[0-9a-f]{40}(?: # .*)?$",
      "^ {8}with:$",
      `^ {10}node-version: ${expectedToolchain.node.replaceAll(".", "\\.")}$`,
      "^ {10}cache: npm$",
      "^ {6}- name: Activate and verify exact toolchain$",
      "^ {8}run: \\|$",
      "^ {10}corepack enable npm$",
      `^ {10}test "\\$\\(node --version\\)" = "v${expectedToolchain.node.replaceAll(".", "\\.")}"$`,
      `^ {10}test "\\$\\(npm --version\\)" = "${expectedToolchain.npm.replaceAll(".", "\\.")}"$`,
      "^ {6}- run: npm ci$",
    ].join("\n"),
    "gmu",
  );
  const exactSetupCount = [...workflow.matchAll(exactSetup)].length;
  if (exactSetupCount !== expectedJobCount) {
    fail(
      `${label} must contain ${expectedJobCount} exact Node.js/npm setup and assertion sequence(s); found ${exactSetupCount}`,
    );
  }

  const allNodePins = [
    ...workflow.matchAll(/^\s+node-version:\s*([^\s#]+).*$/gmu),
  ].map(([, version]) => version);
  if (
    allNodePins.length !== expectedJobCount ||
    allNodePins.some((version) => version !== expectedToolchain.node)
  ) {
    fail(`${label} contains a non-exact Node.js toolchain pin`);
  }
}

export function verifyToolchainContract(repositoryRoot) {
  const workspacePackages = Object.fromEntries(
    workspacePaths.map((workspace) => [
      workspace,
      readJson(repositoryRoot, path.join(workspace, "package.json")),
    ]),
  );
  assertToolchainManifestContract({
    lockfile: readJson(repositoryRoot, "package-lock.json"),
    nodeVersion: readText(repositoryRoot, ".node-version"),
    rootPackage: readJson(repositoryRoot, "package.json"),
    workspacePackages,
  });
  assertWorkflowToolchain(
    readText(repositoryRoot, ".github/workflows/ci.yml"),
    "Required CI workflow",
    9,
  );
  assertWorkflowToolchain(
    readText(repositoryRoot, ".github/workflows/security.yml"),
    "Required security workflow",
    1,
  );
}
