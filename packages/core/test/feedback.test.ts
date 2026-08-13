import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { projectRecipientFeedback } from "../src/feedback.js";
import { feedback, intentId } from "./fixtures.js";

describe("deterministic feedback projection (S15)", () => {
  const events = [
    feedback("accepted", "2026-08-13T08:00:00Z"),
    feedback("deferred", "2026-08-13T08:01:00Z"),
    feedback("delivered", "2026-08-13T08:02:00Z"),
    feedback("opened", "2026-08-13T08:03:00Z"),
    feedback("clicked", "2026-08-13T08:04:00Z"),
    feedback("complained", "2026-08-13T08:05:00Z"),
  ] as const;

  const project = (inputEvents: typeof events | readonly (typeof events)[number][]) =>
    projectRecipientFeedback({ intentId, recipientKey: "a".repeat(64), events: inputEvents });

  it("is invariant under provider delivery reordering", () => {
    const expected = project(events);
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...events], { maxLength: events.length, minLength: events.length }),
        (shuffled) => {
          expect(project(shuffled)).toEqual(expected);
        },
      ),
    );
  });

  it("is idempotent under duplicate event delivery", () => {
    expect(project([...events, events[2], events[2]])).toEqual(project(events));
  });

  it("keeps engagement and complaint independent from transport truth", () => {
    expect(project(events)).toMatchObject({
      clicked: true,
      complaint: true,
      opened: true,
      transportState: "delivered",
    });
  });

  it("preserves contradictory delivered and later bounced facts", () => {
    const projection = projectRecipientFeedback({
      events: [
        feedback("delivered", "2026-08-13T08:00:00Z"),
        feedback("bounced", "2026-08-13T09:00:00Z"),
      ],
      intentId,
      recipientKey: "a".repeat(64),
    });
    expect(projection.transportState).toBe("bounced");
    expect(projection.contradictions).toContain("delivered_and_bounced");
  });

  it("resolves hostile duplicate identity mismatch deterministically", () => {
    const original = feedback("delivered", "2026-08-13T08:00:00Z");
    const conflict = { ...original, kind: "bounced" as const };
    const left = projectRecipientFeedback({
      events: [original, conflict],
      intentId,
      recipientKey: "a".repeat(64),
    });
    const right = projectRecipientFeedback({
      events: [conflict, original],
      intentId,
      recipientKey: "a".repeat(64),
    });
    expect(left).toEqual(right);
    expect(left.contradictions).toContain("provider_event_identity_mismatch");
  });
});
