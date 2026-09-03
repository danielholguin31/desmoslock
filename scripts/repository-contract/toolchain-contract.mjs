import path from "node:path";

import { fail, readJson, readText } from "./shared.mjs";

export const expectedToolchain = Object.freeze({
  node: "24.20.0",
  npm: "11.12.1",
  npmIntegrity:
    "sha512.cdca14b85d647b3192028d02aadbe82d75f79a446aceea9874be98e6d768f20ebd3555770a48d0e9906106007877bbc690f715e9372f2e2dc644a3c3157fb14c",
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
  if (
    rootPackage.packageManager !==
    `npm@${expectedToolchain.npm}+${expectedToolchain.npmIntegrity}`
  ) {
    fail(
      `Root packageManager must pin npm ${expectedToolchain.npm} with its verified Corepack integrity`,
    );
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
  const jobs = readWorkflowJobs(workflow);
  const nodeJobs = jobs.filter((job) => jobUsesNodeToolchain(job.body));
  if (nodeJobs.length !== expectedJobCount) {
    fail(
      `${label} must contain exactly ${expectedJobCount} Node.js/npm job(s); found ${nodeJobs.length}`,
    );
  }
  for (const job of nodeJobs) {
    const setupMatches = [...job.body.matchAll(exactSetup)];
    if (setupMatches.length !== 1) {
      fail(
        `${label} job ${job.name} must contain exactly one exact Node.js/npm setup and assertion sequence`,
      );
    }
    const nodePins = [
      ...job.body.matchAll(/^\s+node-version:\s*([^\s#]+).*$/gmu),
    ].map(([, version]) => version);
    if (nodePins.length !== 1 || nodePins[0] !== expectedToolchain.node) {
      fail(`${label} job ${job.name} contains a non-exact Node.js pin`);
    }
    const firstCommand = firstNodeToolchainCommandIndex(job.body);
    if (
      firstCommand === null ||
      setupMatches[0]?.index === undefined ||
      setupMatches[0].index > firstCommand
    ) {
      fail(
        `${label} job ${job.name} must activate the exact toolchain before Node.js/npm use`,
      );
    }
  }
}

function readWorkflowJobs(workflow) {
  const jobsMarker = /^jobs:\s*$/mu.exec(workflow);
  if (jobsMarker === null) {
    fail("Workflow jobs section is missing");
  }
  const jobsStart = jobsMarker.index + jobsMarker[0].length;
  const remainder = workflow.slice(jobsStart);
  const nextTopLevel = /^\S[^:\n]*:\s*$/mu.exec(remainder);
  const jobsSection = remainder.slice(0, nextTopLevel?.index);
  const matches = [...jobsSection.matchAll(/^ {2}([a-zA-Z0-9_-]+):\s*$/gmu)];
  return matches.map((match, index) => {
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? jobsSection.length;
    return {
      body: jobsSection.slice(bodyStart, bodyEnd),
      name: match[1],
    };
  });
}

function nodeToolchainCommandLine(line) {
  return (
    /\b(?:node|npm|npx|corepack)\b/u.test(line) &&
    !/uses: actions\/setup-node@/u.test(line) &&
    !/^\s*node-version:/u.test(line) &&
    !/^\s*cache: npm\s*$/u.test(line) &&
    !/name: Activate and verify exact toolchain/u.test(line)
  );
}

function firstNodeToolchainCommandIndex(job) {
  let offset = 0;
  for (const line of job.split("\n")) {
    if (nodeToolchainCommandLine(line)) {
      return offset;
    }
    offset += line.length + 1;
  }
  return null;
}

function jobUsesNodeToolchain(job) {
  return firstNodeToolchainCommandIndex(job) !== null;
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
