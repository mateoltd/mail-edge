import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  parseAlloyCommands,
  parseAlloyExecutionReceipt,
  parseFormalToolchainLock,
  parseTlaInvariants,
  parseTlcExecutionReceipt,
} from "../src/formal-execution.js";

const formalFile = (relativePath: string): string =>
  readFileSync(new URL(`../../../formal/${relativePath}`, import.meta.url), "utf8");

describe("pinned formal execution", () => {
  it("accepts the complete digest-pinned toolchain and rejects an unpinned runtime", () => {
    const lock: unknown = JSON.parse(formalFile("toolchain.lock.json"));
    const parsed = parseFormalToolchainLock(lock);

    expect(parsed.artifacts.map((artifact) => artifact.id)).toEqual(["alloy-dist", "tla2tools"]);
    expect(parsed.runtime.image).toMatch(/@sha256:[0-9a-f]{64}$/u);
    expect(() =>
      parseFormalToolchainLock({
        ...parsed,
        runtime: { ...parsed.runtime, image: "eclipse-temurin:21-jre" },
      }),
    ).toThrow("Formal toolchain lock is invalid.");
  });

  it("derives every configured TLA+ invariant and Alloy command from source", () => {
    const invariants = parseTlaInvariants(formalFile("tla/MailEdgeOperations.cfg"));
    const commands = parseAlloyCommands(formalFile("alloy/mail-edge-structure.als"));

    expect(invariants).toHaveLength(13);
    expect(commands.filter((command) => command.type === "check")).toHaveLength(14);
    expect(commands.filter((command) => command.type === "run")).toHaveLength(4);
  });

  it("accepts only a complete successful TLC state-space receipt", () => {
    const output = `TLC2 Version 2.19 of 08 August 2024 (rev: reviewed)
Model checking completed. No error has been found.
7,880,014 states generated, 618,041 distinct states found, 0 states left on queue.
The depth of the complete state graph search is 23.
`;
    expect(parseTlcExecutionReceipt(output)).toEqual({
      distinctStates: 618_041,
      errors: 0,
      maxDepth: 23,
      statesGenerated: 7_880_014,
    });
    expect(() =>
      parseTlcExecutionReceipt(output.replace("No error has been found.", "An error was found.")),
    ).toThrow("TLC did not emit the reviewed successful execution receipt.");
  });

  it("rejects Alloy counterexamples, missing witnesses, and command drift", () => {
    const expected = Object.freeze([
      Object.freeze({ name: "Safety", type: "check" as const }),
      Object.freeze({ name: "Witness", type: "run" as const }),
    ]);
    const receipt = {
      commands: {
        Safety: { name: "Safety", type: "check" },
        Witness: { name: "Witness", solution: [{}], type: "run" },
      },
      solver: "sat4j",
    };
    expect(parseAlloyExecutionReceipt(receipt, expected)).toEqual({
      checks: 1,
      counterexamples: 0,
      properties: ["Safety", "Witness"],
      witnesses: 1,
    });
    expect(() =>
      parseAlloyExecutionReceipt(
        {
          ...receipt,
          commands: { ...receipt.commands, Safety: { ...receipt.commands.Safety, solution: [{}] } },
        },
        expected,
      ),
    ).toThrow("Alloy check Safety found a counterexample.");
    expect(() =>
      parseAlloyExecutionReceipt(
        {
          ...receipt,
          commands: { ...receipt.commands, Witness: { name: "Witness", type: "run" } },
        },
        expected,
      ),
    ).toThrow("Alloy witness Witness is unsatisfiable.");
    expect(() =>
      parseAlloyExecutionReceipt(
        { ...receipt, commands: { ...receipt.commands, Extra: { name: "Extra", type: "check" } } },
        expected,
      ),
    ).toThrow("Alloy receipt command scope differs from the model.");
  });
});
