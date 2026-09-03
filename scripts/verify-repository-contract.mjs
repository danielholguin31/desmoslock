import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyCiContract } from "./repository-contract/ci-contract.mjs";
import { verifyEvidenceContract } from "./repository-contract/evidence-contract.mjs";
import { verifyLegacyQuarantineContract } from "./repository-contract/legacy-quarantine-contract.mjs";
import { readJson } from "./repository-contract/shared.mjs";
import { verifySourceReconciliationContract } from "./repository-contract/source-reconciliation-contract.mjs";
import { verifySupabaseContract } from "./repository-contract/supabase-contract.mjs";
import { verifyToolchainContract } from "./repository-contract/toolchain-contract.mjs";
import { verifyWorkspaceContract } from "./repository-contract/workspace-contract.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const reconciliation = readJson(
  repositoryRoot,
  "docs/product-completion/source-reconciliation.json",
);

verifyWorkspaceContract(repositoryRoot);
verifyLegacyQuarantineContract(repositoryRoot, reconciliation.draftRelease);
verifySourceReconciliationContract(repositoryRoot, reconciliation);
verifyEvidenceContract(repositoryRoot, reconciliation.retainedEvidence);
verifyCiContract(repositoryRoot);
verifyToolchainContract(repositoryRoot);
verifySupabaseContract(repositoryRoot);

process.stdout.write(
  "Repository contract verified: v2-only workspaces and release paths are guarded.\n",
);
