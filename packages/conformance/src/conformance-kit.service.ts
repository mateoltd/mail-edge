import {
  bindingPlanDigest,
  DispatchBoundaryRecorder,
  MailEdgeError,
  ProviderAdapterRegistry,
  ProviderDispatchService,
  ProviderFeedbackIngressService,
  ProviderInboundIngressService,
  StrictBoundedBodyCollector,
  conformanceCheckDigest,
  desiredBindingDigest,
  evaluateReconciliationEvidence,
  inspectBindingPlan,
  inspectProviderCapabilityDescriptor,
  requiredConformanceChecks,
  sha256CanonicalJson,
  validateProviderFeedbackBatch,
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
  type ProviderFeedbackV1,
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
import {
  DEFAULT_PROVIDER_CONFORMANCE_RUN_BUDGET_MILLISECONDS,
  createProviderConformanceTimeWindow,
  timestampWithinConformanceWindow,
  type ProviderConformanceTimeWindow,
} from "./conformance-time.js";

/** @public */
export const PROVIDER_CONFORMANCE_SUITE_VERSION = "1.0.0";

/** @public */
export type DispatchConformanceScenario =
  "accepted_recipient_specific" | "pre_boundary_failure" | "post_boundary_failure";

/** @public */
export type FeedbackConformanceScenario = "malformed" | "duplicates" | "adversarial_order";

/** @public */
export type ReconciliationConformanceScenario = "accepted" | "not_sent" | "unknown";

/** Finite execution context supplied to every adapter-owned conformance callback. @public */
export interface ProviderConformanceCallbackContext {
  readonly deadline: string;
  readonly signal: AbortSignal;
}

/** Adapter-supplied protocol fixtures used by the provider-neutral executable harness. @public */
export interface ProviderConformanceDriver {
  createInboundRequest?(
    fixtures: ProviderConformanceFixtures,
    context: ProviderConformanceCallbackContext,
  ): Promise<{
    readonly request: OneShotProviderHttpRequest;
    readonly context?: ProviderHttpIngressContext;
    readonly services?: InboundIngestionServices;
  }>;
  prepareDispatchScenario?(
    scenario: DispatchConformanceScenario,
    fixtures: ProviderConformanceFixtures,
    context: ProviderConformanceCallbackContext,
  ): Promise<void> | void;
  createDispatchServices?(
    fixtures: ProviderConformanceFixtures,
    context: ProviderConformanceCallbackContext,
  ):
    | Promise<Pick<ProviderDispatchContext, "rawSource" | "secrets">>
    | Pick<ProviderDispatchContext, "rawSource" | "secrets">;
  createDispatchSubmission?(
    submission: ProviderConformanceFixtures["submission"],
    fixtures: ProviderConformanceFixtures,
    context: ProviderConformanceCallbackContext,
  ): Promise<ProviderConformanceFixtures["submission"]> | ProviderConformanceFixtures["submission"];
  createFeedbackRequest?(
    scenario: FeedbackConformanceScenario,
    fixtures: ProviderConformanceFixtures,
    context: ProviderConformanceCallbackContext,
  ): Promise<OneShotProviderHttpRequest>;
  createFeedbackRequests?(
    scenario: FeedbackConformanceScenario,
    fixtures: ProviderConformanceFixtures,
    context: ProviderConformanceCallbackContext,
  ): Promise<readonly OneShotProviderHttpRequest[]>;
  prepareReconciliationScenario?(
    scenario: ReconciliationConformanceScenario,
    fixtures: ProviderConformanceFixtures,
    context: ProviderConformanceCallbackContext,
  ): Promise<void> | void;
  controlStateDigest?(context: ProviderConformanceCallbackContext): Promise<string> | string;
}

/** Non-secret environment dimensions accepted by signed conformance evidence. @public */
export type ProviderConformanceEnvironmentKey =
  "accountTier" | "deployment" | "runtime" | "transport";

/** Explicit authorization marker for real control-plane mutation probes. @public */
export interface ProviderConformanceMutationTarget {
  readonly protected: true;
  readonly scope: "qualification" | "sandbox";
}

/** Complete target exported by a third-party adapter qualification module. @public */
export interface ProviderConformanceTarget {
  readonly registration: ProviderAdapterRegistration;
  readonly driver: ProviderConformanceDriver;
  readonly region: string;
  readonly environment: Readonly<Partial<Record<ProviderConformanceEnvironmentKey, string>>>;
  readonly mutationTarget?: ProviderConformanceMutationTarget;
}

/** @public */
export interface ProviderConformanceRunOptions {
  readonly observedAt: string;
  readonly runBudgetMilliseconds?: number;
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
  services?: Pick<ProviderDispatchContext, "rawSource" | "secrets">,
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
    rawSource: services?.rawSource ?? new FixtureRawSource(fixtures),
    secrets: services?.secrets ?? new FixtureSecretResolver(),
  });

const submissionForDescriptor = (
  fixtures: ProviderConformanceFixtures,
  registration: ProviderAdapterRegistration,
): ProviderConformanceFixtures["submission"] => {
  const support = registration.descriptor.outbound.envelope;
  const recipients = (
    support.multipleRecipients ? fixtures.envelope.rcptTo : fixtures.envelope.rcptTo.slice(0, 1)
  ).map((recipient) =>
    Object.freeze({
      address: recipient.address,
      ...(support.perRecipientDsn && recipient.dsn !== undefined ? { dsn: recipient.dsn } : {}),
    }),
  );
  const body = support.bodyModes[0];
  const envelope = Object.freeze({
    ...(body === undefined ? {} : { body }),
    ...(support.dsnRetEnvid && fixtures.envelope.dsn !== undefined
      ? { dsn: fixtures.envelope.dsn }
      : {}),
    mailFrom: fixtures.envelope.mailFrom,
    rcptTo: Object.freeze(recipients),
    ...(support.requireTls ? { requireTls: true } : {}),
    schemaVersion: "v1" as const,
    smtpUtf8: false,
  });
  return Object.freeze({ ...fixtures.submission, envelope });
};

const asFailureCode = (cause: unknown): string =>
  cause instanceof MailEdgeError ? cause.code.toLowerCase() : "probe_threw";

const environmentKeys = Object.freeze([
  "accountTier",
  "deployment",
  "runtime",
  "transport",
] as const satisfies readonly ProviderConformanceEnvironmentKey[]);

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const conformanceFailure = (
  reason: string,
  cause?: unknown,
  code: "INTERNAL" | "VALIDATION_FAILED" = "INTERNAL",
): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code,
    deliveryCertainty: "not_sent",
    message: "Provider conformance execution failed.",
    retryable: code === "INTERNAL",
    safeDetails: { reason },
  });

const normalizeEnvironment = (
  environment: ProviderConformanceTarget["environment"],
): Result<Readonly<Record<string, string>>, MailEdgeErrorType> => {
  const entries = Object.entries(environment);
  if (entries.length > environmentKeys.length) {
    return {
      error: conformanceFailure("environment_key_not_allowlisted", undefined, "VALIDATION_FAILED"),
      ok: false,
    };
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries.toSorted(([left], [right]) => compareCodeUnits(left, right))) {
    if (!environmentKeys.some((allowed) => allowed === key)) {
      return {
        error: conformanceFailure(
          "environment_key_not_allowlisted",
          undefined,
          "VALIDATION_FAILED",
        ),
        ok: false,
      };
    }
    if (typeof value !== "string" || value.length < 1 || value.length > 1_024) {
      return {
        error: conformanceFailure("environment_value_invalid", undefined, "VALIDATION_FAILED"),
        ok: false,
      };
    }
    normalized[key] = sha256CanonicalJson({
      domain: "mail-edge/provider-conformance/environment/v1",
      key,
      value,
    });
  }
  return { ok: true, value: Object.freeze(normalized) };
};

const validControlStateDigest = (value: string | undefined): value is string =>
  value !== undefined && /^[0-9a-f]{64}$/u.test(value);

const isProtectedMutationTarget = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "protected" in value &&
  value.protected === true &&
  "scope" in value &&
  (value.scope === "qualification" || value.scope === "sandbox");

const fixtureTimeWindow = (
  fixtures: ProviderConformanceFixtures,
): Pick<ProviderConformanceTimeWindow, "observedAt" | "probeDeadline"> =>
  Object.freeze({ observedAt: fixtures.observedAt, probeDeadline: fixtures.deadline });

const awaitWithSignal = async <Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> => {
  if (signal.aborted) throw signal.reason;
  let rejectCancellation: ((reason: unknown) => void) | undefined;
  const canceled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (): void => rejectCancellation?.(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([operation, canceled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

class ProviderConformanceRunOwner {
  readonly #budgetSignal: AbortSignal;
  readonly #context: ProviderConformanceCallbackContext;
  readonly signal: AbortSignal;

  constructor(callerSignal: AbortSignal, timing: ProviderConformanceTimeWindow, budget: number) {
    this.#budgetSignal = AbortSignal.timeout(budget);
    this.signal = AbortSignal.any([callerSignal, this.#budgetSignal]);
    this.#context = Object.freeze({ deadline: timing.probeDeadline, signal: this.signal });
  }

  get budgetExceeded(): boolean {
    return this.#budgetSignal.aborted;
  }

  callback<Value>(operation: () => Promise<Value> | Value): Promise<Value> {
    return awaitWithSignal(Promise.resolve().then(operation), this.signal);
  }

  context(): ProviderConformanceCallbackContext {
    return this.#context;
  }
}

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
    const runBudgetMilliseconds =
      options.runBudgetMilliseconds ?? DEFAULT_PROVIDER_CONFORMANCE_RUN_BUDGET_MILLISECONDS;
    const timing = createProviderConformanceTimeWindow(
      options.observedAt,
      this.#target.registration.descriptor.maturity,
      runBudgetMilliseconds,
    );
    if (!timing.ok) return timing;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(this.#target.region)) {
      return {
        error: conformanceFailure("region_invalid", undefined, "VALIDATION_FAILED"),
        ok: false,
      };
    }
    const environment = normalizeEnvironment(this.#target.environment);
    if (!environment.ok) return environment;
    const runOwner = new ProviderConformanceRunOwner(signal, timing.value, runBudgetMilliseconds);
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
      return {
        ok: true,
        value: this.#finish(timing.value, environment.value, checks, undefined),
      };
    }

    const started = await registry.start(runOwner.signal);
    if (!started.ok) {
      checks.push(fail("lifecycle.start_close", "lifecycle", started.error.code.toLowerCase()));
      await registry.close(runOwner.signal);
      return {
        ok: true,
        value: this.#finish(timing.value, environment.value, checks, undefined),
      };
    }

    const fixtures = createProviderConformanceFixtures(
      this.#target.registration.identity,
      timing.value,
    );
    let probeFailure: unknown;
    try {
      if (descriptor.inbound.supported) {
        checks.push(...(await this.#runInbound(fixtures, runOwner)));
      }
      if (descriptor.outbound.supported) {
        checks.push(...(await this.#runOutbound(fixtures, runOwner)));
      }
      if (descriptor.feedback.supported) {
        checks.push(...(await this.#runFeedback(fixtures, runOwner)));
      }
      if (descriptor.controlPlane.supported) {
        checks.push(...(await this.#runControl(fixtures, runOwner)));
      }
      if (descriptor.outbound.reconciliation.supported) {
        checks.push(...(await this.#runReconciliation(fixtures, runOwner)));
      }
    } catch (cause) {
      probeFailure = cause;
    } finally {
      try {
        const closed = await registry.close(runOwner.signal);
        checks.push(
          closed.ok
            ? pass("lifecycle.start_close", "lifecycle", "reverse_close_complete")
            : fail("lifecycle.start_close", "lifecycle", closed.error.code.toLowerCase()),
        );
      } catch (cause) {
        probeFailure ??= cause;
      }
    }
    if (probeFailure !== undefined) {
      return {
        error: conformanceFailure(
          runOwner.budgetExceeded ? "run_budget_exceeded" : "harness_failure",
          probeFailure,
        ),
        ok: false,
      };
    }
    return {
      ok: true,
      value: this.#finish(timing.value, environment.value, checks, fixtures),
    };
  }

  async #runInbound(
    fixtures: ProviderConformanceFixtures,
    runOwner: ProviderConformanceRunOwner,
  ): Promise<readonly ConformanceCheckResultV1[]> {
    const inbound = this.#target.registration.inbound;
    if (inbound === undefined || this.#target.driver.createInboundRequest === undefined)
      return Object.freeze([]);
    const supplied = await runOwner.callback(() =>
      this.#target.driver.createInboundRequest?.(fixtures, runOwner.context()),
    );
    if (supplied === undefined) return Object.freeze([]);
    const stage = new FixtureBlobStagePort();
    const result = await new ProviderInboundIngressService(
      inbound,
      supplied.services ?? createFixtureInboundServices(fixtures, stage),
    ).execute(
      supplied.request,
      supplied.context ?? createFixtureIngressContext(fixtures),
      runOwner.signal,
    );
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
    const limited = await new StrictBoundedBodyCollector(2).collectSmallBody(
      overLimit,
      2,
      runOwner.signal,
    );
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
    runOwner: ProviderConformanceRunOwner,
  ): Promise<readonly ConformanceCheckResultV1[]> {
    const outbound = this.#target.registration.outbound;
    if (outbound === undefined || this.#target.driver.prepareDispatchScenario === undefined)
      return Object.freeze([]);
    const checks: ConformanceCheckResultV1[] = [];
    const run = async (scenario: DispatchConformanceScenario) => {
      await runOwner.callback(() =>
        this.#target.driver.prepareDispatchScenario?.(scenario, fixtures, runOwner.context()),
      );
      const services = await runOwner.callback(() =>
        this.#target.driver.createDispatchServices?.(fixtures, runOwner.context()),
      );
      const baseSubmission = submissionForDescriptor(fixtures, this.#target.registration);
      const submission =
        (await runOwner.callback(() =>
          this.#target.driver.createDispatchSubmission?.(
            baseSubmission,
            fixtures,
            runOwner.context(),
          ),
        )) ?? baseSubmission;
      const sink = new CountingInstrumentationSink();
      const context = contextForDispatch(this.#target, fixtures, sink, services);
      const execution = await new ProviderDispatchService(outbound).execute(
        submission,
        context,
        runOwner.signal,
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
    runOwner: ProviderConformanceRunOwner,
  ): Promise<readonly ConformanceCheckResultV1[]> {
    const adapter = this.#target.registration.feedback;
    if (
      adapter === undefined ||
      (this.#target.driver.createFeedbackRequest === undefined &&
        this.#target.driver.createFeedbackRequests === undefined)
    )
      return Object.freeze([]);
    const run = async (scenario: FeedbackConformanceScenario) => {
      const supplied = await runOwner.callback(() =>
        this.#target.driver.createFeedbackRequests === undefined
          ? this.#target.driver
              .createFeedbackRequest?.(scenario, fixtures, runOwner.context())
              .then((request) => Object.freeze([request]))
          : this.#target.driver.createFeedbackRequests(scenario, fixtures, runOwner.context()),
      );
      if (supplied === undefined || supplied.length < 1) {
        throw new Error("Feedback conformance driver supplied no requests.");
      }
      const events: ProviderFeedbackV1[] = [];
      for (const request of supplied) {
        const result = await new ProviderFeedbackIngressService(
          adapter,
          new StrictBoundedBodyCollector(),
        ).execute(request, createFixtureIngressContext(fixtures), runOwner.signal);
        if (!result.ok) return result;
        events.push(...result.value.events);
      }
      const validated = validateProviderFeedbackBatch(
        events,
        adapter.descriptor,
        fixtures.providerInstanceId,
      );
      return validated.ok ? { ok: true as const, value: validated.value.events } : validated;
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
    runOwner: ProviderConformanceRunOwner,
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
    const desiredDigest = desiredBindingDigest(desired);
    const before = await runOwner.callback(() =>
      this.#target.driver.controlStateDigest?.(runOwner.context()),
    );
    const first = await control.planBinding(desired, runOwner.signal);
    const second = await control.planBinding(desired, runOwner.signal);
    const afterPlan = await runOwner.callback(() =>
      this.#target.driver.controlStateDigest?.(runOwner.context()),
    );
    const firstInspection = first.ok
      ? inspectBindingPlan(
          first.value,
          this.#target.registration.identity,
          desiredDigest,
          fixtures.observedAt,
        )
      : undefined;
    const secondInspection = second.ok
      ? inspectBindingPlan(
          second.value,
          this.#target.registration.identity,
          desiredDigest,
          fixtures.observedAt,
        )
      : undefined;
    const deterministic =
      first.ok &&
      second.ok &&
      firstInspection?.valid === true &&
      secondInspection?.valid === true &&
      bindingPlanDigest(first.value) === bindingPlanDigest(second.value);
    const planningVerified =
      deterministic && validControlStateDigest(before) && before === afterPlan;
    const checks = [
      planningVerified
        ? pass("control.plan_deterministic", "control", "pure_plan")
        : fail(
            "control.plan_deterministic",
            "control",
            !validControlStateDigest(before) || !validControlStateDigest(afterPlan)
              ? "control_state_digest_unavailable"
              : (firstInspection?.issues[0] ??
                  secondInspection?.issues[0] ??
                  "plan_nondeterministic_or_mutating"),
          ),
    ];
    if (
      !first.ok ||
      !second.ok ||
      firstInspection?.valid !== true ||
      secondInspection?.valid !== true ||
      !planningVerified
    ) {
      const evidenceCode =
        !validControlStateDigest(before) || !validControlStateDigest(afterPlan)
          ? "control_state_digest_unavailable"
          : "validated_plan_unavailable";
      checks.push(
        fail("control.discovery_read_only", "control", evidenceCode),
        fail("control.explicit_mutation", "control", evidenceCode),
      );
      return Object.freeze(checks);
    }
    const beforeDiscover = await runOwner.callback(() =>
      this.#target.driver.controlStateDigest?.(runOwner.context()),
    );
    const discovered = await control.discoverBinding(fixtures.binding, runOwner.signal);
    const afterDiscover = await runOwner.callback(() =>
      this.#target.driver.controlStateDigest?.(runOwner.context()),
    );
    const discoveryVerified =
      discovered.ok &&
      validControlStateDigest(beforeDiscover) &&
      beforeDiscover === afterDiscover &&
      timestampWithinConformanceWindow(discovered.value.discoveredAt, fixtureTimeWindow(fixtures));
    checks.push(
      discoveryVerified
        ? pass("control.discovery_read_only", "control", "discovery_read_only")
        : fail(
            "control.discovery_read_only",
            "control",
            !validControlStateDigest(beforeDiscover) || !validControlStateDigest(afterDiscover)
              ? "control_state_digest_unavailable"
              : discovered.ok &&
                  !timestampWithinConformanceWindow(
                    discovered.value.discoveredAt,
                    fixtureTimeWindow(fixtures),
                  )
                ? "discovery_time_invalid"
                : "discovery_mutated",
          ),
    );
    if (!isProtectedMutationTarget(this.#target.mutationTarget)) {
      checks.push(
        fail("control.explicit_mutation", "control", "protected_mutation_target_required"),
      );
      return Object.freeze(checks);
    }
    if (!discoveryVerified) {
      checks.push(
        fail("control.explicit_mutation", "control", "verified_read_only_precondition_required"),
      );
      return Object.freeze(checks);
    }
    const beforeApply = await runOwner.callback(() =>
      this.#target.driver.controlStateDigest?.(runOwner.context()),
    );
    if (!validControlStateDigest(beforeApply)) {
      checks.push(fail("control.explicit_mutation", "control", "control_state_digest_unavailable"));
      return Object.freeze(checks);
    }
    const applied = await control.applyBindingPlan(
      first.value,
      Object.freeze({
        actorIdHash: "2".repeat(64),
        deadline: fixtures.deadline,
        operationId: "conformance-apply",
        reasonCode: "provider_conformance",
      }),
      runOwner.signal,
    );
    const afterApply = await runOwner.callback(() =>
      this.#target.driver.controlStateDigest?.(runOwner.context()),
    );
    checks.push(
      applied.ok &&
        validControlStateDigest(beforeApply) &&
        validControlStateDigest(afterApply) &&
        beforeApply !== afterApply &&
        applied.value.planDigest === firstInspection.planDigest &&
        timestampWithinConformanceWindow(applied.value.appliedAt, fixtureTimeWindow(fixtures))
        ? pass("control.explicit_mutation", "control", "authorized_apply_only")
        : fail(
            "control.explicit_mutation",
            "control",
            !validControlStateDigest(beforeApply) || !validControlStateDigest(afterApply)
              ? "control_state_digest_unavailable"
              : applied.ok && applied.value.planDigest !== firstInspection.planDigest
                ? "applied_plan_digest_mismatch"
                : applied.ok &&
                    !timestampWithinConformanceWindow(
                      applied.value.appliedAt,
                      fixtureTimeWindow(fixtures),
                    )
                  ? "apply_time_invalid"
                  : "apply_not_observable",
          ),
    );
    return Object.freeze(checks);
  }

  async #runReconciliation(
    fixtures: ProviderConformanceFixtures,
    runOwner: ProviderConformanceRunOwner,
  ): Promise<readonly ConformanceCheckResultV1[]> {
    const outbound = this.#target.registration.outbound;
    if (
      outbound?.reconcile === undefined ||
      this.#target.driver.prepareReconciliationScenario === undefined
    )
      return Object.freeze([]);
    const query: ProviderReconciliationQueryV1 = Object.freeze({
      attemptId: fixtures.attemptId,
      providerMessageId: "018f1f2e-7b4a-7c11-8a00-000000000010",
      routeBinding: fixtures.binding,
      schemaVersion: "v1",
      window: Object.freeze({
        from: fixtures.observedAt,
        to: fixtures.deadline,
      }),
    });
    const run = async (scenario: ReconciliationConformanceScenario) => {
      await runOwner.callback(() =>
        this.#target.driver.prepareReconciliationScenario?.(scenario, fixtures, runOwner.context()),
      );
      const result = await outbound.reconcile?.(query, runOwner.signal);
      if (
        result?.ok !== true ||
        !timestampWithinConformanceWindow(result.value.observedAt, fixtureTimeWindow(fixtures))
      ) {
        return undefined;
      }
      return evaluateReconciliationEvidence(result.value, outbound.descriptor);
    };
    const accepted = await run("accepted");
    const notSent = await run("not_sent");
    const unknown = await run("unknown");
    const declared = outbound.descriptor.outbound.reconciliation.canProve;
    const acceptedValid = declared.includes("accepted")
      ? accepted?.nextState === "provider_accepted"
      : accepted?.nextState === "quarantined_unknown";
    const notSentValid = declared.includes("not_sent")
      ? notSent?.nextState === "failed_not_sent"
      : notSent?.nextState === "quarantined_unknown";
    return Object.freeze([
      acceptedValid && notSentValid
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
    timing: ProviderConformanceTimeWindow,
    environment: Readonly<Record<string, string>>,
    checks: readonly ConformanceCheckResultV1[],
    fixtures: ProviderConformanceFixtures | undefined,
  ): ProviderConformanceRun {
    const required = requiredConformanceChecks(this.#target.registration.descriptor);
    const allChecks = [...checks, ...skippedRequiredChecks(required, checks)].toSorted(
      (left, right) => compareCodeUnits(left.checkId, right.checkId),
    );
    const report: ProviderConformanceReportV1 = Object.freeze({
      adapterVersion: this.#target.registration.identity.adapterVersion,
      checks: Object.freeze(allChecks),
      descriptorDigest: sha256CanonicalJson(this.#target.registration.descriptor),
      environment,
      expiresAt: timing.reportExpiresAt,
      fixtureSetDigest:
        fixtures?.fixtureSetDigest ??
        sha256CanonicalJson({
          identity: Object.freeze({ ...this.#target.registration.identity }),
          observedAt: timing.observedAt,
        }),
      mode: this.#target.registration.identity.mode,
      observedAt: timing.observedAt,
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
