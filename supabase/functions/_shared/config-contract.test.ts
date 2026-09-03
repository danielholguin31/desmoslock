import configToml from "../../config.toml" with { type: "text" };

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function functionSection(name: string): string[] {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [
    ...configToml.matchAll(
      new RegExp(
        `^\\[functions\\.${escapedName}\\]\\n([^[]*)(?=^\\[|\\s*$)`,
        "gmu",
      ),
    ),
  ];
  assertEquals(matches.length, 1);
  return matches[0][1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

Deno.test(
  "account recovery explicitly disables gateway JWT verification",
  () => {
    assertEquals(functionSection("account-recovery"), ["verify_jwt = false"]);
  },
);

Deno.test(
  "staff invitations explicitly enables gateway JWT verification",
  () => {
    assertEquals(functionSection("staff-invitations"), ["verify_jwt = true"]);
  },
);
