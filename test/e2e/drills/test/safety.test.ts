import { describe, expect, test } from "vitest";

import { restoreWorkflowDecision } from "../src/backup-restore.service.js";
import { parseRunbookArguments } from "../src/run-drills.js";
import { isLoopbackServiceUrl, parseRunbookConfiguration } from "../src/safety.js";

const sourceRevision = "51f7b6e3f031960f4ba812d356f89a308b759bfe";

describe("production drill fail-closed boundary", () => {
  test("requires explicit ephemeral confirmation and a bounded relative evidence path", () => {
    expect(parseRunbookConfiguration({ DRILL_SOURCE_REVISION: sourceRevision })).toEqual({
      error: { code: "invalid_confirmation" },
      ok: false,
    });
    expect(
      parseRunbookConfiguration({
        DRILL_CONFIRM: "ephemeral-only",
        DRILL_EVIDENCE_DIRECTORY: "../../outside",
        DRILL_SOURCE_REVISION: sourceRevision,
      }),
    ).toEqual({ error: { code: "invalid_evidence_directory" }, ok: false });
    expect(
      parseRunbookConfiguration({
        DRILL_CONFIRM: "ephemeral-only",
        DRILL_SOURCE_REVISION: sourceRevision,
      }),
    ).toMatchObject({ ok: true });
  });

  test("refuses non-loopback infrastructure", () => {
    expect(isLoopbackServiceUrl("postgresql://owner:secret@127.0.0.1:5432/mail_edge")).toBe(true);
    expect(isLoopbackServiceUrl("http://localhost:9000")).toBe(true);
    expect(isLoopbackServiceUrl("http://[::1]:9000")).toBe(true);
    expect(isLoopbackServiceUrl("postgres://owner:secret@localhost:5432/mail_edge")).toBe(true);
    expect(isLoopbackServiceUrl("https://storage.example.com/bucket")).toBe(false);
    expect(isLoopbackServiceUrl("postgresql://db.internal/mail_edge")).toBe(false);
  });

  test("parses only reviewed runbook flags and drill identifiers", () => {
    expect(
      parseRunbookArguments([
        "--confirm",
        "ephemeral-only",
        "--source-revision",
        sourceRevision,
        "--focus",
        "orphan_repair",
      ]),
    ).toMatchObject({ ok: true, value: { focus: "orphan_repair" } });
    expect(parseRunbookArguments(["--focus", "provider_send"])).toEqual({
      error: "invalid_focus",
      ok: false,
    });
    expect(parseRunbookArguments(["--unknown", "value"])).toEqual({
      error: "invalid_argument",
      ok: false,
    });
  });

  test("quarantines only restore-cut dispatch ambiguity", () => {
    expect(restoreWorkflowDecision("dispatching")).toBe("quarantine");
    expect(restoreWorkflowDecision("accepted")).toBe("replay_safe");
    expect(restoreWorkflowDecision("ready")).toBe("replay_safe");
    expect(restoreWorkflowDecision("retry_wait")).toBe("replay_safe");
    expect(restoreWorkflowDecision("provider_accepted")).toBe("terminal");
  });
});
