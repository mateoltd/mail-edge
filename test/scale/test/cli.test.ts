import { describe, expect, it } from "vitest";

import { runQualificationCli } from "../src/cli.js";

describe("qualification CLI boundaries", () => {
  it("accepts the package-runner option delimiter", async () => {
    await expect(runQualificationCli(["help", "--"])).resolves.toBeUndefined();
  });

  it("rejects unknown options instead of silently ignoring configuration", async () => {
    await expect(runQualificationCli(["help", "--unexpected"])).rejects.toThrow(
      "Unknown CLI option",
    );
  });
});
