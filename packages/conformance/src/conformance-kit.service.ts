import {
  DispatchBoundaryRecorder,
  MailEdgeError,
  ProviderAdapterRegistry,
  ProviderDispatchService,
  ProviderFeedbackIngressService,
  ProviderInboundIngressService,
  StrictBoundedBodyCollector,
  conformanceCheckDigest,
  evaluateReconciliationEvidence,
  inspectProviderCapabilityDescriptor,
  requiredConformanceChecks,
  sha256CanonicalJson,
  type CanonicalJsonValue,
  type ConformanceCheckResultV1,
  type DesiredBindingV1,
  type InboundIngestionServices,
  type MailEdgeError as MailEdgeErrorType,
  type OneShotProviderHttpRequest,
  type ProviderAdapterRegistration,
  type ProviderConformanceReportV1,
  type ProviderDispatchContext,
  type ProviderDispatchInstrumentationEvent,
  type ProviderDispatchInstrumentationSink,
  type ProviderHttpIngressContext,
  type ProviderReconciliationQueryV1,
  type Result,
} from "@mail-edge/provider";

import {
  FixtureBlobStagePort,
  FixtureClock,
  FixtureRawSource,
  FixtureSecretResolver,
  createFixtureHttpRequest,
  createFixtureInboundServices,
  createFixtureIngressContext,
  createProviderConformanceFixtures,
  type ProviderConformanceFixtures,
} from "./conformance-fixtures.adapter.js";

/** @public */
export const PROVIDER_CONFORMANCE_SUITE_VERSION = "1.0.0";

/** @public */
export type DispatchConformanceScenario =
  "accepted_recipient_specific" | "pre_boundary_failure" | "post_boundary_failure";

/** @public */
export type FeedbackConformanceScenario = "malformed" | "duplicates" | "adversarial_order";

/** @public */
export type ReconciliationConformanceScenario = "accepted" | "not_sent" | "unknown";

/** Adapter-supplied protocol fixtures used by the provider-neutral executable harness. @public */
export interface ProviderConformanceDriver {
  createInboundRequest?(fixtures: ProviderConformanceFixtures): Promise<{
    readonly request: OneShotProviderHttpRequest;
    readonly context?: ProviderHttpIngressContext;
    readonly services?: InboundIngestionServices;
  }>;
  prepareDispatchScenario?(
    scenario: DispatchConformanceScenario,
    fixtures: ProviderConformanceFixtures,
  ): Promise<void> | void;
  createFeedbackRequest?(
    scenario: FeedbackConformanceScenario,
    fixtures: ProviderConformanceFixtures,
  ): Promise<OneShotProviderHttpRequest>;
  prepareReconciliationScenario?(
    scenario: ReconciliationConformanceScenario,
    fixtures: ProviderConformanceFixtures,
  ): Promise<void> | void;
  controlStateDigest?(): Promise<string> | string;
}

/** Complete target exported by a third-party adapter qualification module. @public */
export interface ProviderConformanceTarget {
  readonly registration: ProviderAdapterRegistration;
  readonly driver: ProviderConformanceDriver;
  readonly region: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** @public */
export interface ProviderConformanceRunOptions {
  readonly observedAt: string;
}

/** @public */
export interface ProviderConformanceRun {
  readonly report: ProviderConformanceReportV1;
  readonly passed: boolean;
  readonly passedChecks: readonly string[];
  readonly failedChecks: readonly string[];
}

interface CheckInput {
  readonly checkId: string;
  readonly capability: string;
  readonly outcome: "pass" | "fail";
  readonly evidenceCode: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

const resultCheck = (input: CheckInput): ConformanceCheckResultV1 => {
  const withoutDigest = Object.freeze({
    capability: input.capability,
    checkId: input.checkId,
    ...(input.details === undefined ? {} : { details: Object.freeze(input.details) }),
    evidenceCode: input.evidenceCode,
    evidenceDigest: "0".repeat(64),
    outcome: input.outcome,
  });
  return Object.freeze({
    ...withoutDigest,
    evidenceDigest: conformanceCheckDigest(withoutDigest),
  });
};

const pass = (
  checkId: string,
  capability: string,
  evidenceCode = "verified",
  details?: CheckInput["details"],
): ConformanceCheckResultV1 =>
  resultCheck({
    capability,
    checkId,
    ...(details === undefined ? {} : { details }),
    evidenceCode,
    outcome: "pass",
  });

const fail = (
  checkId: string,
  capability: string,
  evidenceCode: string,
  details?: CheckInput["details"],
): ConformanceCheckResultV1 =>
  resultCheck({
    capability,
    checkId,
    ...(details === undefined ? {} : { details }),
    evidenceCode,
    outcome: "fail",
  });

const capabilityForCheck = (checkId: string): string => checkId.split(".", 1)[0] ?? "suite";

const skippedRequiredChecks = (
  required: readonly string[],
  checks: readonly ConformanceCheckResultV1[],
): readonly ConformanceCheckResultV1[] => {
  const seen = new Set(checks.map((check) => check.checkId));
  return Object.freeze(
    required
      .filter((checkId) => !seen.has(checkId))
      .map((checkId) => fail(checkId, capabilityForCheck(checkId), "probe_not_supplied")),
  );
};

const dispatchTransport = (registration: ProviderAdapterRegistration): "http" | "smtp" =>
  registration.descriptor.outbound.transports.includes("smtp_raw") ? "smtp" : "http";

class CountingInstrumentationSink implements ProviderDispatchInstrumentationSink {
  readonly events: ProviderDispatchInstrumentationEvent[] = [];

  record(event: ProviderDispatchInstrumentationEvent): void {
    this.events.push(event);
  }
}

const contextForDispatch = (
  target: ProviderConformanceTarget,
  fixtures: ProviderConformanceFixtures,
  sink: CountingInstrumentationSink,
): ProviderDispatchContext =>
  Object.freeze({
    boundary: new DispatchBoundaryRecorder({
      mode: target.registration.identity.mode,
      providerId: target.registration.identity.providerId,
      sink,
      transport: dispatchTransport(target.registration),
    }),
    clock: new FixtureClock(fixtures.observedAt),
    mode: target.registration.identity.mode,
    providerInstanceId: fixtures.providerInstanceId,
    rawSource: new FixtureRawSource(fixtures),
    secrets: new FixtureSecretResolver(),
  });

const asFailureCode = (cause: unknown): string =>
  cause instanceof MailEdgeError ? cause.code.toLowerCase() : "probe_threw";

/**
 * Executes static, lifecycle, streaming, dispatch-boundary, feedback, control, and reconciliation
 * probes and emits a deterministic unsigned report suitable for detached signing.
 *
 * @public
 */
export class ProviderConformanceKit {
  readonly #target: ProviderConformanceTarget;

  constructor(target: ProviderConformanceTarget) {
    this.#target = target;
  }

  async run(
    options: ProviderConformanceRunOptions,
    signal: AbortSignal,
  ): Promise<Result<ProviderConformanceRun, MailEdgeErrorType>> {
    const checks: ConformanceCheckResultV1[] = [];
    const descriptor = this.#target.registration.descriptor;
    const inspection = inspectProviderCapabilityDescriptor(descriptor);
    checks.push(
      inspection.valid
        ? pass("descriptor.schema", "descriptor", "schema_valid")
        : fail("descriptor.schema", "descriptor", "schema_invalid"),
      inspection.valid
        ? pass("descriptor.semantic", "descriptor", "claims_consistent")
        : fail("descriptor.semantic", "descriptor", inspection.issues[0] ?? "claims_invalid"),
    );

    let registry: ProviderAdapterRegistry;
    try {
      registry = new ProviderAdapterRegistry([this.#target.registration]);
      checks.push(pass("identity.registration", "identity", "exact_identity_registered"));
    } catch (cause) {
      checks.push(fail("identity.registration", "identity", asFailureCode(cause)));
      return { ok: true, value: this.#finish(options.observedAt, checks, undefined) };
    }

    const started = await registry.start(signal);
    if (!started.ok) {
      checks.push(fail("lifecycle.start_close", "lifecycle", started.error.code.toLowerCase()));
      return { ok: true, value: this.#finish(options.observedAt, checks, undefined) };
    }

    const fixtures = createProviderConformanceFixtures(
      this.#target.registration.identity,
      options.observedAt,
    );
    try {
      if (descriptor.inbound.supported) {
        checks.push(...(await this.#runInbound(fixtures, signal)));
      }
      if (descriptor.outbound.supported) {
        checks.push(...(await this.#runOutbound(fixtures, signal)));
      }
      if (descriptor.feedback.supported) {
        checks.push(...(await this.#runFeedback(fixtures, signal)));
      }
      if (descriptor.controlPlane.supported) {
        checks.push(...(await this.#runControl(fixtures, signal)));
      }
      if (descriptor.outbound.reconciliation.supported) {
        checks.push(...(await this.#runReconciliation(fixtures, signal)));
      }
    } catch (cause) {
      return {
        error: new MailEdgeError({
          cause,
          code: "INTERNAL",
          deliveryCertainty: "not_sent",
          message: "Provider conformance harness failed unexpectedly.",
          retryable: false,
          safeDetails: { reason: "harness_failure" },
        }),
        ok: false,
      };
    } finally {
      const closed = await registry.close(signal);
      checks.push(
        closed.ok
          ? pass("lifecycle.start_close", "lifecycle", "reverse_close_complete")
          : fail("lifecycle.start_close", "lifecycle", closed.error.code.toLowerCase()),
      );
    }
    return { ok: true, value: this.#finish(options.observedAt, checks, fixtures) };
  }

  async #runInbound(
    fixtures: ProviderConformanceFixtures,
    signal: AbortSignal,
  ): Promise<readonly ConformanceCheckResultV1[]> {
    const inbound = this.#target.registration.inbound;
    if (inbound === undefined || this.#target.driver.createInboundRequest === undefined)
      return Object.freeze([]);
    const supplied = await this.#target.driver.createInboundRequest(fixtures);
    const stage = new FixtureBlobStagePort();
    const result = await new ProviderInboundIngressService(
      inbound,
      supplied.services ?? createFixtureInboundServices(fixtures, stage),
    ).execute(supplied.request, supplied.context ?? createFixtureIngressContext(fixtures), signal);
    let secondReadRejected = false;
    try {
      supplied.request.body[Symbol.asyncIterator]();
    } catch {
      secondReadRejected = true;
    }
    const checks = [
      result.ok && supplied.request.body.state === "completed" && secondReadRejected
        ? pass("ingress.one_shot", "inbound", "owned_once")
        : fail("ingress.one_shot", "inbound", "ownership_violation"),
    ];

    const overLimit = createFixtureHttpRequest(Uint8Array.of(1, 2, 3), fixtures.observedAt, {
      contentLength: 2,
      chunkBytes: 1,
    });
    const limited = await new StrictBoundedBodyCollector(2).collectSmallBody(overLimit, 2, signal);
    checks.push(
      !limited.ok &&
        limited.error.code === "INGRESS_LIMIT_EXCEEDED" &&
        overLimit.body.state === "aborted"
        ? pass("ingress.stream_limits", "inbound", "observed_limit_enforced")
        : fail("ingress.stream_limits", "inbound", "observed_limit_not_enforced"),
    );
    return Object.freeze(checks);
  }

  async #runOutbound(
    fixtures: ProviderConformanceFixtures,
    signal: AbortSignal,
  ): Promise<readonly ConformanceCheckResultV1[]> {
    const outbound = this.#target.registration.outbound;
    if (outbound === undefined || this.#target.driver.prepareDispatchScenario === undefined)
      return Object.freeze([]);
    const checks: ConformanceCheckResultV1[] = [];
    const run = async (scenario: DispatchConformanceScenario) => {
      await this.#target.driver.prepareDispatchScenario?.(scenario, fixtures);
      const sink = new CountingInstrumentationSink();
      const context = contextForDispatch(this.#target, fixtures, sink);
      const execution = await new ProviderDispatchService(outbound).execute(
        fixtures.submission,
        context,
        signal,
      );
      return { execution, sink };
    };

    const accepted = await run("accepted_recipient_specific");
    checks.push(
      accepted.execution.action === "accepted"
        ? pass("dispatch.recipient_outcomes", "outbound", "all_recipients_accounted")
        : fail("dispatch.recipient_outcomes", "outbound", "acceptance_invalid"),
    );
    const pre = await run("pre_boundary_failure");
    checks.push(
      !pre.execution.result.ok &&
        pre.execution.result.error.deliveryCertainty === "not_sent" &&
        !pre.execution.boundary.classification.boundaryCrossed
        ? pass("dispatch.pre_boundary_not_sent", "outbound", "zero_bytes_not_sent")
        : fail("dispatch.pre_boundary_not_sent", "outbound", "pre_boundary_misclassified"),
    );
    const post = await run("post_boundary_failure");
    const unknownQuarantined =
      !post.execution.result.ok &&
      post.execution.result.error.deliveryCertainty === "unknown" &&
      !post.execution.result.error.retryable &&
      post.execution.action === "quarantine_unknown";
    checks.push(
      unknownQuarantined
        ? pass("dispatch.post_boundary_unknown", "outbound", "first_byte_unknown")
        : fail("dispatch.post_boundary_unknown", "outbound", "post_boundary_misclassified"),
      unknownQuarantined
        ? pass("dispatch.unknown_quarantined", "outbound", "automatic_retry_forbidden")
        : fail("dispatch.unknown_quarantined", "outbound", "unknown_retryable"),
    );
    return Object.freeze(checks);
  }

  async #runFeedback(
    fixtures: ProviderConformanceFixtures,
    signal: AbortSignal,
  ): Promise<readonly ConformanceCheckResultV1[]> {
    const adapter = this.#target.registration.feedback;
    if (adapter === undefined || this.#target.driver.createFeedbackRequest === undefined)
      return Object.freeze([]);
    const run = async (scenario: FeedbackConformanceScenario) => {
      const request = await this.#target.driver.createFeedbackRequest?.(scenario, fixtures);
      if (request === undefined) throw new Error("Feedback conformance driver disappeared.");
      return new ProviderFeedbackIngressService(adapter, new StrictBoundedBodyCollector()).execute(
        request,
        createFixtureIngressContext(fixtures),
        signal,
      );
    };
    const malformed = await run("malformed");
    const duplicates = await run("duplicates");
    const adversarial = await run("adversarial_order");
    const ordered =
      adversarial.ok &&
      adversarial.value.every(
        (event, index, events) =>
          index === 0 || (events[index - 1]?.sequenceHint ?? 0) <= (event.sequenceHint ?? 0),
      );
    const checks = [
      !malformed.ok
        ? pass("feedback.malformed_rejected", "feedback", "malformed_rejected")
        : fail("feedback.malformed_rejected", "feedback", "malformed_accepted"),
      duplicates.ok && duplicates.value.length === fixtures.feedback.length
        ? pass("feedback.duplicates_deduplicated", "feedback", "provider_identity_deduped")
        : fail("feedback.duplicates_deduplicated", "feedback", "duplicate_not_deduped"),
      ordered
        ? pass("feedback.ordering_deterministic", "feedback", "adversarial_order_normalized")
        : fail("feedback.ordering_deterministic", "feedback", "ordering_nondeterministic"),
    ];
    if (adapter.descriptor.feedback.perRecipient) {
      const recipientSpecific =
        duplicates.ok && duplicates.value.every((event) => event.recipient !== undefined);
      checks.push(
        recipientSpecific
          ? pass("feedback.recipient_specific", "feedback", "recipient_present")
          : fail("feedback.recipient_specific", "feedback", "recipient_missing"),
      );
    }
    return Object.freeze(checks);
  }

  async #runControl(
    fixtures: ProviderConformanceFixtures,
    signal: AbortSignal,
  ): Promise<readonly ConformanceCheckResultV1[]> {
    const control = this.#target.registration.controlPlane;
    if (control === undefined) return Object.freeze([]);
    const desired: DesiredBindingV1 = Object.freeze({
      configRevision: fixtures.binding.configRevision,
      direction: "outbound",
      domainALabel: fixtures.binding.domainALabel,
      providerInstanceId: fixtures.providerInstanceId,
      requirementsDigest: "1".repeat(64),
      schemaVersion: "v1",
      tenantId: fixtures.tenantId,
    });
    const before = await this.#target.driver.controlStateDigest?.();
    const first = await control.planBinding(desired, signal);
    const second = await control.planBinding(desired, signal);
    const afterPlan = await this.#target.driver.controlStateDigest?.();
    const deterministic =
      first.ok &&
      second.ok &&
      sha256CanonicalJson(first.value as unknown as CanonicalJsonValue) ===
        sha256CanonicalJson(second.value as unknown as CanonicalJsonValue);
    const checks = [
      deterministic && (before === undefined || before === afterPlan)
        ? pass("control.plan_deterministic", "control", "pure_plan")
        : fail("control.plan_deterministic", "control", "plan_nondeterministic_or_mutating"),
    ];
    if (!first.ok) {
      checks.push(
        fail("control.discovery_read_only", "control", "plan_unavailable"),
        fail("control.explicit_mutation", "control", "plan_unavailable"),
      );
      return Object.freeze(checks);
    }
    const beforeDiscover = await this.#target.driver.controlStateDigest?.();
    const discovered = await control.discoverBinding(fixtures.binding, signal);
    const afterDiscover = await this.#target.driver.controlStateDigest?.();
    checks.push(
      discovered.ok && (beforeDiscover === undefined || beforeDiscover === afterDiscover)
        ? pass("control.discovery_read_only", "control", "discovery_read_only")
        : fail("control.discovery_read_only", "control", "discovery_mutated"),
    );
    const beforeApply = await this.#target.driver.controlStateDigest?.();
    const applied = await control.applyBindingPlan(
      first.value,
      Object.freeze({
        actorIdHash: "2".repeat(64),
        deadline: new Date(Date.parse(fixtures.observedAt) + 60_000).toISOString(),
        operationId: "conformance-apply",
        reasonCode: "provider_conformance",
      }),
      signal,
    );
    const afterApply = await this.#target.driver.controlStateDigest?.();
    checks.push(
      applied.ok && (beforeApply === undefined || beforeApply !== afterApply)
        ? pass("control.explicit_mutation", "control", "authorized_apply_only")
        : fail("control.explicit_mutation", "control", "apply_not_observable"),
    );
    return Object.freeze(checks);
  }

  async #runReconciliation(
    fixtures: ProviderConformanceFixtures,
    signal: AbortSignal,
  ): Promise<readonly ConformanceCheckResultV1[]> {
    const outbound = this.#target.registration.outbound;
    if (
      outbound?.reconcile === undefined ||
      this.#target.driver.prepareReconciliationScenario === undefined
    )
      return Object.freeze([]);
    const query: ProviderReconciliationQueryV1 = Object.freeze({
      attemptId: fixtures.attemptId,
      routeBinding: fixtures.binding,
      schemaVersion: "v1",
      window: Object.freeze({
        from: fixtures.observedAt,
        to: new Date(Date.parse(fixtures.observedAt) + 60_000).toISOString(),
      }),
    });
    const run = async (scenario: ReconciliationConformanceScenario) => {
      await this.#target.driver.prepareReconciliationScenario?.(scenario, fixtures);
      const result = await outbound.reconcile?.(query, signal);
      return result?.ok
        ? evaluateReconciliationEvidence(result.value, outbound.descriptor)
        : undefined;
    };
    const accepted = await run("accepted");
    const notSent = await run("not_sent");
    const unknown = await run("unknown");
    return Object.freeze([
      accepted?.nextState === "provider_accepted" && notSent?.nextState === "failed_not_sent"
        ? pass("reconciliation.certainty_transitions", "reconciliation", "authoritative_only")
        : fail(
            "reconciliation.certainty_transitions",
            "reconciliation",
            "certainty_transition_invalid",
          ),
      unknown?.nextState === "quarantined_unknown" && !unknown.resolved
        ? pass("reconciliation.unknown_preserved", "reconciliation", "unknown_remains_quarantined")
        : fail("reconciliation.unknown_preserved", "reconciliation", "unknown_resolved_unsafely"),
    ]);
  }

  #finish(
    observedAt: string,
    checks: readonly ConformanceCheckResultV1[],
    fixtures: ProviderConformanceFixtures | undefined,
  ): ProviderConformanceRun {
    const required = requiredConformanceChecks(this.#target.registration.descriptor);
    const allChecks = [...checks, ...skippedRequiredChecks(required, checks)].toSorted(
      (left, right) => left.checkId.localeCompare(right.checkId),
    );
    const expiresAt = new Date(
      Date.parse(observedAt) +
        (this.#target.registration.descriptor.maturity === "stable" ? 30 : 7) * 86_400_000,
    ).toISOString();
    const report: ProviderConformanceReportV1 = Object.freeze({
      adapterVersion: this.#target.registration.identity.adapterVersion,
      checks: Object.freeze(allChecks),
      descriptorDigest: sha256CanonicalJson(this.#target.registration.descriptor),
      environment: Object.freeze(
        Object.fromEntries(
          Object.entries(this.#target.environment).toSorted(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      ),
      expiresAt,
      fixtureSetDigest:
        fixtures?.fixtureSetDigest ??
        sha256CanonicalJson({
          identity: this.#target.registration.identity as unknown as CanonicalJsonValue,
          observedAt,
        }),
      mode: this.#target.registration.identity.mode,
      observedAt,
      providerId: this.#target.registration.identity.providerId,
      region: this.#target.region,
      schemaVersion: "v1",
      suiteVersion: PROVIDER_CONFORMANCE_SUITE_VERSION,
    });
    const failedChecks = allChecks
      .filter((check) => check.outcome === "fail")
      .map((check) => check.checkId);
    const passedChecks = allChecks
      .filter((check) => check.outcome === "pass")
      .map((check) => check.checkId);
    return Object.freeze({
      failedChecks: Object.freeze(failedChecks),
      passed: failedChecks.length === 0,
      passedChecks: Object.freeze(passedChecks),
      report,
    });
  }
}
