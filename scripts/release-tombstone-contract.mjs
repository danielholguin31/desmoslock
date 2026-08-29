export const expectedLegacyReleaseTombstone = `name: Legacy v1 release (disabled)

on:
  workflow_dispatch:

permissions: {}

jobs:
  legacy-v1-release-disabled:
    name: Legacy v1 release is disabled during v2 expansion
    runs-on: ubuntu-latest
    steps:
      - name: Refuse legacy release execution
        shell: bash
        run: |
          echo "::error::Legacy v1 release is disabled; only reviewed v2 source on main may enter a future release pipeline."
          exit 1
`;

const forbiddenPatterns = [
  [
    "tag or push trigger",
    /^\s+(?:push|release|schedule|repository_dispatch|tags):/mu,
  ],
  ["write permission", /(?:write-all|:\s*write\s*$)/imu],
  ["environment", /^\s+environment:/imu],
  ["third-party action", /^\s+-\s+uses:/imu],
  ["secret expression", /\bsecrets\s*\./iu],
  ["artifact transfer", /(?:upload-artifact|download-artifact)/iu],
  [
    "release or publish behavior",
    /(?:gh\s+release|npm\s+publish|action-gh-release)/iu,
  ],
  [
    "packaging or deploy behavior",
    /(?:electron-builder|wrangler\s+deploy|vercel\s+deploy)/iu,
  ],
];

export function assertLegacyReleaseTombstone(contents) {
  for (const [label, pattern] of forbiddenPatterns) {
    if (pattern.test(contents)) {
      throw new Error(`Legacy release tombstone contains forbidden ${label}`);
    }
  }
  if (contents !== expectedLegacyReleaseTombstone) {
    throw new Error(
      "Legacy release workflow must remain the exact manual, least-privilege, always-failing tombstone",
    );
  }
}
