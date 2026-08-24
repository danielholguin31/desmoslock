import { describe, expect, it } from "vitest";

import { internalWorkspacePreview } from "../src/main.js";

describe("web v2 foundation", () => {
  it("starts with no imported legacy product rows", () => {
    expect(internalWorkspacePreview).toEqual([]);
  });
});
