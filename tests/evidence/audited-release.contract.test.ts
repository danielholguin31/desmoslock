import { describe, it } from "vitest";

const sourceCommit = "ddcfce456f3cf015ab77d207310140a311c945ab";

describe(`v2 recovery contracts preserved from ${sourceCommit}`, () => {
  it.todo("REC-01 rejects every Supabase lookup error");
  it.todo("REC-02 rejects a Supabase authentication lookup error");
  it.todo("REC-03 rejects a Supabase Student row lookup error");
  it.todo("REC-04 rejects a Supabase Test row lookup error");
  it.todo("REC-05 reserves null for authoritative absent or inactive state");
  it.todo("REC-06 engages a persisted lock before a stalled calculator load");
  it.todo("REC-07 engages a persisted lock before a never-resolving restore");
  it.todo("REC-08 clears stale locked state before loading the calculator");
  it.todo(
    "REC-09 releases recovery lock and clears an authoritative missing session",
  );
});

describe(`v2 release-provenance contracts preserved from ${sourceCommit}`, () => {
  it.todo("PROV-01 pins npm by version and tarball hash");
  it.todo("PROV-02 regenerates vendor code only on the canonical builder");
  it.todo("PROV-03 normalizes supported GitHub origin URL formats");
  it.todo(
    "PROV-04 rejects redirects credentials alternate hosts and ambiguous origins",
  );
  it.todo(
    "PROV-05 accepts an explicitly updated repository identity after transfer",
  );
  it.todo("PROV-06 accepts exact all-platform hosted provenance");
  it.todo("PROV-07 rejects malformed build time and tool versions");
  it.todo("PROV-08 rejects mismatched source and workflow identity");
  it.todo("PROV-09 rejects untrusted hosted runner attributes");
  it.todo("PROV-10 accepts exact macOS source builder and tool provenance");
  it.todo("PROV-11 accepts two-component full-Xcode SDK versions");
  it.todo(
    "PROV-12 rejects false macOS source and malformed builder provenance",
  );
  it.todo("PROV-13 requires a real second-precision UTC instant");
});

describe(`v2 Gatekeeper contracts preserved from ${sourceCommit}`, () => {
  it.todo("GK-01 binds each host role to its exact scope and options");
  it.todo(
    "GK-02 fingerprints hardware deterministically without exposing identifiers",
  );
  it.todo("GK-03 binds host roles to the physical Mac hardware family");
  it.todo("GK-04 accepts only the exact credential-free draft asset URL");
  it.todo("GK-05 binds draft snapshots to release asset IDs sizes and hashes");
  it.todo(
    "GK-06 requires truthful draft disclosures and rejects bypass advice",
  );
  it.todo("GK-07 normalizes a private saved GitHub draft response");
  it.todo("GK-08 rejects malformed GitHub draft identity and asset evidence");
  it.todo("GK-09 requires witnessed dialog Open Anyway and relaunch evidence");
  it.todo("GK-10 requires the exact ordered checksum contract");
  it.todo("GK-11 accepts exact Mini ARM and MacBook ARM plus Rosetta receipts");
  it.todo(
    "GK-12 rejects wrong scope missing Rosetta and unwitnessed launch claims",
  );
  it.todo("GK-13 rejects one physical host reused for both roles");
  it.todo(
    "GK-14 rejects cross-receipt source release asset manifest or hash mismatch",
  );
  it.todo(
    "GK-15 reads quarantine without mutation and writes private receipts",
  );
});
