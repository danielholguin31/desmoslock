import { spawnSync } from "node:child_process";

const containerName = "supabase_db_desmoslock-v2";
const deadline = Date.now() + 60_000;
let consecutiveHealthyChecks = 0;

while (Date.now() < deadline && consecutiveHealthyChecks < 3) {
  const inspection = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.Health.Status}}", containerName],
    { encoding: "utf8" },
  );
  if (inspection.status === 0 && inspection.stdout.trim() === "healthy") {
    consecutiveHealthyChecks += 1;
  } else {
    consecutiveHealthyChecks = 0;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

if (consecutiveHealthyChecks < 3) {
  throw new Error(`Postgres container ${containerName} did not become healthy`);
}

process.stdout.write("Postgres reported healthy three consecutive times.\n");
