import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import {
  MailEdgeError,
  DomainALabelSchema,
  parseBindingId,
  parseIdempotencyKey,
  parseIntentId,
  parseProviderId,
  parseProviderInstanceId,
  parseRawAccessGrantId,
  parseReceiptId,
  parseTenantId,
  projectProblem,
  RawMessageRefV1Schema,
  RouteBindingSnapshotV1Schema,
  SmtpEnvelopeV1Schema,
  type Result,
  validateContract,
} from "@mail-edge/contracts";
import {
  ProviderFeedbackIngressService,
  ProviderInboundIngressService,
  StrictBoundedBodyCollector,
  type BindingPlanV1,
  type ControlPlaneOperationContext,
  type DesiredBindingV1,
  type ProviderAdapterRegistration,
  type ProviderFeedbackIngressBatch,
  type InboundIngressCommit,
  type ProviderAdapterRegistry,
  type RouteBindingSnapshotV1,
} from "@mail-edge/provider";
import type { MailEdgeSdk } from "@mail-edge/sdk";
import type { OpenTelemetryMetricProducer } from "@mail-edge/observability";
import type { BlobStorePort, Clock } from "@mail-edge/core";
import fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from "fastify";

import {
  ApiValidator,
  AppliedBindingResourcesSchema,
  ApplyPlanRequestSchema,
  BindingLifecycleParamsSchema,
  LifecycleDecisionSchema,
  BindingDiscoveryRequestSchema,
  BindingOperationRequestSchema,
  BindingPlanSchema,
  DeletionEvidenceSchema,
  DesiredBindingSchema,
  DiscoveredBindingResourcesSchema,
  FeedbackHandoffResultSchema,
  OutboundIntentRequestSchema,
  OutboundQuarantineDecisionSchema,
  InboundQuarantineDecisionSchema,
  ProviderInstanceParamsSchema,
  ProviderRouteParamsSchema,
  RawAccessGrantParamsSchema,
  RawAccessGrantRequestSchema,
  RawAccessGrantRevocationSchema,
  TenantIntentParamsSchema,
  TenantParamsSchema,
  TenantBindingParamsSchema,
  TenantReceiptParamsSchema,
  TenantRawAccessGrantParamsSchema,
  type ProviderInstanceParams,
  type ProviderRouteParams,
  type RawAccessGrantParams,
  type TenantRawAccessGrantParams,
  type BindingPlanInput,
  type DesiredBindingInput,
  type TenantIntentParams,
  type BindingLifecycleParams,
  type TenantBindingParams,
  type TenantParams,
  type TenantReceiptParams,
} from "./api-schema.js";
import type { StaticTokenAuthenticator } from "./authentication.js";
import type { BoundedConcurrencyGate } from "./concurrency.js";
import type { ReferenceServiceConfig } from "./config.js";
import { asHostError, hostError } from "./errors.js";
import { bindInboundServices } from "./ingress-boundary.js";
import type { ProviderInstanceCatalog } from "./instance-catalog.js";
import type { LifecycleComponent } from "./lifecycle.js";
import type {
  AuthenticatedActor,
  AuthScope,
  ControlServicePort,
  ControlPlaneHandoffContext,
  ProviderInstanceBinding,
  RawAccessServicePort,
  ReferenceServiceWorkflowPort,
} from "./ports.js";
import {
  asReadableBody,
  collectBoundedJson,
  providerHttpRequest,
  readableByteSource,
  RequestAbortScope,
  requestContentLength,
} from "./request-body.js";
import { UuidV7Generator } from "./uuid-v7.service.js";
import type { HostTracer } from "./telemetry.js";

interface HttpDependencies {
  readonly authenticator: StaticTokenAuthenticator;
  readonly blobStore: BlobStorePort;
  readonly catalog: ProviderInstanceCatalog;
  readonly clock: Clock;
  readonly config: ReferenceServiceConfig;
  readonly control: ControlServicePort;
  readonly gate: BoundedConcurrencyGate;
  readonly metrics: Pick<OpenTelemetryMetricProducer, "recordSecurityRejection" | "startIngress">;
  readonly readiness: (signal: AbortSignal) => Promise<Result<void, MailEdgeError>>;
  readonly registry: ProviderAdapterRegistry;
  readonly rawAccess: RawAccessServicePort;
  readonly sdk: MailEdgeSdk;
  readonly shutdownSignal: AbortSignal;
  readonly tracer: HostTracer;
  readonly workflow: ReferenceServiceWorkflowPort;
}

type RequestOperation<T> = (
  signal: AbortSignal,
  requestId: string,
) => Promise<Result<T, MailEdgeError>>;

const deadline = (clock: Clock, timeoutMilliseconds: number): string =>
  new Date(Date.parse(clock.now()) + timeoutMilliseconds).toISOString();

const exactBinding = (
  binding: RouteBindingSnapshotV1,
  instance: ProviderInstanceBinding,
): boolean =>
  binding.tenantId === instance.tenantId &&
  binding.providerId === instance.identity.providerId &&
  binding.adapterVersion === instance.identity.adapterVersion &&
  binding.providerInstanceId === instance.providerInstanceId;

const invalidControlInput = <T>(): Result<T, MailEdgeError> => ({
  error: hostError("VALIDATION_FAILED", "control_input_invalid", { retryable: false }),
  ok: false,
});

const desiredBinding = (input: DesiredBindingInput): Result<DesiredBindingV1, MailEdgeError> => {
  const tenant = parseTenantId(input.tenantId);
  const providerInstance = parseProviderInstanceId(input.providerInstanceId);
  const domain = validateContract(DomainALabelSchema, input.domainALabel);
  if (!tenant.ok || !providerInstance.ok || !domain.ok) return invalidControlInput();
  return {
    ok: true,
    value: Object.freeze({
      ...input,
      domainALabel: domain.value,
      providerInstanceId: providerInstance.value,
      tenantId: tenant.value,
    }),
  };
};

const bindingPlan = (input: BindingPlanInput): Result<BindingPlanV1, MailEdgeError> => {
  const providerId = parseProviderId(input.identity.providerId);
  if (!providerId.ok) return invalidControlInput();
  return {
    ok: true,
    value: Object.freeze({
      ...input,
      identity: Object.freeze({ ...input.identity, providerId: providerId.value }),
      operations: Object.freeze(
        input.operations.map((operation) =>
          Object.freeze({ ...operation, parameters: Object.freeze({ ...operation.parameters }) }),
        ),
      ),
    }),
  };
};

const isMailEdgeResult = <T>(value: unknown): value is Result<T, MailEdgeError> => {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if (value.ok === true) return "value" in value;
  return value.ok === false && "error" in value && value.error instanceof MailEdgeError;
};

const errorCode = (error: FastifyError): string | undefined =>
  "code" in error && typeof error.code === "string" ? error.code : undefined;

const ingressOutcome = (
  result: Result<InboundIngressCommit, MailEdgeError>,
): "accepted" | "duplicate" | "rejected" | "limit_exceeded" | "invalid" | "unavailable" => {
  if (result.ok) return result.value.duplicate ? "duplicate" : "accepted";
  if (result.error.code === "AUTHORIZATION_FAILED") return "rejected";
  if (result.error.code === "INGRESS_LIMIT_EXCEEDED") return "limit_exceeded";
  if (result.error.code === "VALIDATION_FAILED") return "invalid";
  return "unavailable";
};

export class ReferenceHttpServer implements LifecycleComponent {
  readonly name = "http";
  readonly #dependencies: HttpDependencies;
  readonly #server: FastifyInstance;
  readonly #validator = new ApiValidator();
  #address: string | undefined;

  constructor(dependencies: HttpDependencies) {
    this.#dependencies = dependencies;
    const requestIds = new UuidV7Generator();
    const server = fastify({
      bodyLimit: dependencies.config.http.maximumIngressBytes,
      forceCloseConnections: "idle",
      genReqId: () => requestIds.next(),
      keepAliveTimeout: dependencies.config.http.keepAliveTimeoutMilliseconds,
      logger: {
        level: "info",
        redact: {
          paths: [
            "req.headers",
            "request.headers",
            "body",
            "authorization",
            "tenantId",
            "providerInstanceId",
          ],
          remove: true,
        },
      },
      logController: new LogController({ disableRequestLogging: true }),
      requestIdHeader: false,
      requestTimeout: dependencies.config.http.requestTimeoutMilliseconds,
      trustProxy: false,
    });
    server.server.headersTimeout = dependencies.config.http.headersTimeoutMilliseconds;
    server.setValidatorCompiler(TypeBoxValidatorCompiler);
    server.removeAllContentTypeParsers();
    server.addContentTypeParser("*", (_request, payload, done) => {
      done(null, payload);
    });
    this.#server = server;
    this.#registerErrorBoundary();
    this.#registerRoutes();
  }

  get instance(): FastifyInstance {
    return this.#server;
  }

  get address(): string | undefined {
    return this.#address;
  }

  async start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    try {
      signal.throwIfAborted();
      this.#address = await this.#server.listen({
        host: this.#dependencies.config.http.host,
        listenTextResolver: (address) => address,
        port: this.#dependencies.config.http.port,
      });
      return { ok: true, value: undefined };
    } catch (cause) {
      return { error: asHostError(cause, "http_listen_failed"), ok: false };
    }
  }

  async close(): Promise<Result<void, MailEdgeError>> {
    this.#dependencies.gate.close();
    try {
      await this.#server.close();
      this.#address = undefined;
      return { ok: true, value: undefined };
    } catch (cause) {
      return { error: asHostError(cause, "http_close_failed"), ok: false };
    }
  }

  readiness(): Promise<Result<void, MailEdgeError>> {
    return Promise.resolve(
      this.#address === undefined
        ? { error: hostError("HOST_UNAVAILABLE", "http_not_listening"), ok: false }
        : { ok: true, value: undefined },
    );
  }

  #registerErrorBoundary(): void {
    this.#server.setErrorHandler((error, request, reply) => {
      const code = errorCode(error as FastifyError);
      const mapped =
        code === "FST_ERR_CTP_BODY_TOO_LARGE"
          ? hostError("INGRESS_LIMIT_EXCEEDED", "transport_body_limit_exceeded", {
              retryable: false,
              safeDetails: { limit: this.#dependencies.config.http.maximumIngressBytes },
            })
          : code === "FST_ERR_VALIDATION"
            ? hostError("VALIDATION_FAILED", "transport_schema_validation_failed", {
                retryable: false,
              })
            : asHostError(error, "http_boundary_failed");
      request.log.error({ errorCode: mapped.code, event: "http.request_failed" });
      this.#sendProblem(reply, request, mapped);
    });
    this.#server.setNotFoundHandler((request, reply) => {
      this.#sendProblem(
        reply,
        request,
        hostError("NOT_FOUND", "route_not_found", {
          retryable: false,
          safeDetails: { resourceType: "route" },
        }),
      );
    });
  }

  #registerRoutes(): void {
    this.#server.get("/livez", async (_request, reply) => reply.code(200).send({ status: "live" }));
    this.#server.get("/readyz", async (_request, reply) => {
      const signal = AbortSignal.timeout(
        Math.min(this.#dependencies.config.http.requestTimeoutMilliseconds, 5_000),
      );
      const ready = await this.#dependencies.readiness(signal);
      return reply.code(ready.ok ? 200 : 503).send({ status: ready.ok ? "ready" : "not_ready" });
    });
    this.#server.get("/health/degraded", async (_request, reply) => {
      const signal = AbortSignal.timeout(
        Math.min(this.#dependencies.config.http.requestTimeoutMilliseconds, 5_000),
      );
      const ready = await this.#dependencies.readiness(signal);
      const registryStarted = this.#dependencies.registry.state === "started";
      return reply.code(200).send({
        providers: this.#dependencies.registry.list().map((registration) => ({
          identity: registration.identity,
          maturity: registration.descriptor.maturity,
          status: registryStarted ? "operational" : "unavailable",
        })),
        status: ready.ok ? "operational" : "degraded",
      });
    });

    this.#registerProviderIngress();
    this.#registerRawAccess();
    this.#registerTenantApi();
    this.#registerOperatorApi();
  }

  #registerRawAccess(): void {
    this.#server.get<{ Params: RawAccessGrantParams }>(
      "/v1/raw-access-grants/:grantId/raw",
      { schema: { params: RawAccessGrantParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "raw_access.download",
          this.#dependencies.config.http.requestTimeoutMilliseconds,
          async (signal) => {
            if (
              request.headers.range !== undefined ||
              request.headers["if-range"] !== undefined ||
              (request.headers["accept-encoding"] !== undefined &&
                request.headers["accept-encoding"] !== "identity")
            ) {
              return {
                error: hostError("VALIDATION_FAILED", "raw_range_or_encoding_rejected", {
                  retryable: false,
                }),
                ok: false,
              };
            }
            const grantId = parseRawAccessGrantId(request.params.grantId);
            if (!grantId.ok) {
              return { error: hostError("AUTHORIZATION_FAILED", "raw_grant_rejected"), ok: false };
            }
            const authorization = request.headers.authorization;
            const matched =
              typeof authorization === "string"
                ? /^MailEdgeRaw ([A-Za-z0-9_-]{43,128})$/u.exec(authorization)
                : null;
            const audience = request.headers["x-mail-edge-signature-audience"];
            const subjectId = request.headers["x-mail-edge-subject-id"];
            const operation = request.headers["x-mail-edge-operation"];
            if (
              matched?.[1] === undefined ||
              typeof audience !== "string" ||
              typeof subjectId !== "string" ||
              operation !== "raw_download"
            ) {
              return { error: hostError("AUTHORIZATION_FAILED", "raw_grant_rejected"), ok: false };
            }
            const authorized = await this.#dependencies.rawAccess.authorize(
              grantId.value,
              matched[1],
              Object.freeze({ audience, operation, subjectId }),
              signal,
            );
            if (!authorized.ok) return authorized;
            const opened = await this.#dependencies.blobStore.openRaw(
              authorized.value.tenantId,
              authorized.value.raw.blobId,
              signal,
            );
            if (!opened.ok) return opened;
            if (
              opened.value.contentLength !== null &&
              opened.value.contentLength !== authorized.value.raw.size
            ) {
              return { error: hostError("INTERNAL", "raw_stream_metadata_mismatch"), ok: false };
            }
            const stream = Readable.from(opened.value.body, { objectMode: false });
            reply
              .code(200)
              .header("accept-ranges", "none")
              .header("cache-control", "no-store, private")
              .header("content-disposition", 'attachment; filename="message.eml"')
              .header("content-length", String(authorized.value.raw.size))
              .header("content-type", "message/rfc822")
              .header("x-content-type-options", "nosniff")
              .send(stream);
            await finished(stream, { signal });
            return { ok: true, value: undefined };
          },
        ),
    );
  }

  #registerProviderIngress(): void {
    const base = "/v1/providers/:providerId/:adapterVersion/:mode/instances/:providerInstanceId";
    const inbound = async (
      request: FastifyRequest<{ Params: ProviderRouteParams }>,
      reply: FastifyReply,
    ) =>
      this.#run(
        request,
        reply,
        "provider.inbound",
        this.#dependencies.config.http.requestTimeoutMilliseconds,
        async (signal, requestId) => {
          const resolved = this.#dependencies.catalog.resolve(request.params);
          if (!resolved.ok) return resolved;
          const registration = this.#registration(resolved.value);
          if (!registration.ok) return registration;
          if (registration.value.inbound === undefined) {
            return { error: hostError("NOT_FOUND", "inbound_surface_not_found"), ok: false };
          }
          const body = asReadableBody(request.body);
          if (!body.ok) return body;
          const services = await this.#dependencies.workflow.inboundServices(
            resolved.value,
            signal,
          );
          if (!isMailEdgeResult(services) || !services.ok) {
            return isMailEdgeResult(services)
              ? services
              : { error: hostError("INTERNAL", "inbound_services_result_invalid"), ok: false };
          }
          const metricLease = this.#dependencies.metrics.startIngress(
            resolved.value.identity.providerId,
            resolved.value.identity.mode,
          );
          const context = Object.freeze({
            deadline: deadline(
              this.#dependencies.clock,
              this.#dependencies.config.http.requestTimeoutMilliseconds,
            ),
            providerInstanceId: resolved.value.providerInstanceId,
            requestId,
            ...(resolved.value.inboundBindingHint === undefined
              ? {}
              : { bindingHint: resolved.value.inboundBindingHint }),
          });
          let result: unknown;
          try {
            result = await new ProviderInboundIngressService(
              registration.value.inbound,
              bindInboundServices(resolved.value, services.value),
            ).execute(
              providerHttpRequest({
                body: body.value,
                ...(metricLease === undefined
                  ? {}
                  : {
                      observeBytes: (bytes: number) => {
                        metricLease.addBytes(bytes);
                      },
                    }),
                path: request.raw.url?.split("?", 1)[0] ?? "/",
                raw: request.raw,
                receivedAt: this.#dependencies.clock.now(),
              }),
              context,
              signal,
            );
          } catch (cause) {
            metricLease?.close("failed");
            throw cause;
          }
          if (!isMailEdgeResult<InboundIngressCommit>(result)) {
            metricLease?.close("failed");
            return { error: hostError("INTERNAL", "adapter_result_invalid"), ok: false };
          }
          metricLease?.close(ingressOutcome(result));
          if (result.ok) reply.code(result.value.response.statusCode).send();
          return result;
        },
      );
    this.#server.post<{ Params: ProviderRouteParams }>(
      `${base}/inbound`,
      { schema: { params: ProviderRouteParamsSchema } },
      inbound,
    );
    this.#server.post<{ Params: ProviderRouteParams }>(
      `${base}/inbound/*`,
      { schema: { params: ProviderRouteParamsSchema } },
      inbound,
    );

    this.#server.post<{ Params: ProviderRouteParams }>(
      `${base}/feedback`,
      { schema: { params: ProviderRouteParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "provider.feedback",
          this.#dependencies.config.http.requestTimeoutMilliseconds,
          async (signal, requestId) => {
            const resolved = this.#dependencies.catalog.resolve(request.params);
            if (!resolved.ok) return resolved;
            const registration = this.#registration(resolved.value);
            if (!registration.ok) return registration;
            if (registration.value.feedback === undefined) {
              return { error: hostError("NOT_FOUND", "feedback_surface_not_found"), ok: false };
            }
            const body = asReadableBody(request.body);
            if (!body.ok) return body;
            const result: unknown = await new ProviderFeedbackIngressService(
              registration.value.feedback,
              new StrictBoundedBodyCollector(),
            ).execute(
              providerHttpRequest({
                body: body.value,
                path: request.raw.url?.split("?", 1)[0] ?? "/",
                raw: request.raw,
                receivedAt: this.#dependencies.clock.now(),
              }),
              Object.freeze({
                deadline: deadline(
                  this.#dependencies.clock,
                  this.#dependencies.config.http.requestTimeoutMilliseconds,
                ),
                providerInstanceId: resolved.value.providerInstanceId,
                requestId,
              }),
              signal,
            );
            if (!isMailEdgeResult<ProviderFeedbackIngressBatch>(result)) {
              return { error: hostError("INTERNAL", "adapter_result_invalid"), ok: false };
            }
            if (!result.ok) return result;
            const handoff: unknown = await this.#dependencies.workflow.commitFeedback(
              {
                events: result.value.events,
                instance: resolved.value,
                receivedAt: this.#dependencies.clock.now(),
                requestId,
                ...(result.value.replay === undefined ? {} : { replay: result.value.replay }),
              },
              signal,
            );
            if (!isMailEdgeResult(handoff)) {
              return { error: hostError("INTERNAL", "feedback_handoff_result_invalid"), ok: false };
            }
            if (!handoff.ok) return handoff;
            const validated = this.#validator.validate(FeedbackHandoffResultSchema, handoff.value);
            if (!validated.ok) return validated;
            reply.code(202).send();
            return { ok: true, value: undefined };
          },
        ),
    );
  }

  #registerTenantApi(): void {
    this.#server.post<{ Params: TenantParams }>(
      "/v1/tenants/:tenantId/raw-access-grants",
      { schema: { params: TenantParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "tenant.raw_access.issue",
          this.#dependencies.config.http.requestTimeoutMilliseconds,
          async (signal) => {
            const tenant = this.#tenantActor(request, request.params.tenantId, "raw.read");
            if (!tenant.ok) return tenant;
            const body = await this.#json(request, signal);
            if (!body.ok) return body;
            const payload = this.#validator.validate(RawAccessGrantRequestSchema, body.value);
            if (!payload.ok) return payload;
            const raw = validateContract(RawMessageRefV1Schema, payload.value.raw);
            if (!raw.ok)
              return { error: hostError("VALIDATION_FAILED", "raw_ref_invalid"), ok: false };
            const issued = await this.#dependencies.rawAccess.issueForSubject(
              {
                purpose: payload.value.purpose,
                raw: raw.value,
                singleUse: payload.value.singleUse,
                subjectId: payload.value.subjectId,
                tenantId: tenant.value.tenantId,
                actor: {
                  actorIdHash: tenant.value.actorIdHash,
                  actorType: "application",
                  reasonCode: "tenant_request",
                },
              },
              signal,
            );
            if (issued.ok) reply.code(201).send(issued.value);
            return issued;
          },
        ),
    );

    this.#server.post<{ Params: TenantRawAccessGrantParams }>(
      "/v1/tenants/:tenantId/raw-access-grants/:grantId/revoke",
      { schema: { params: TenantRawAccessGrantParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "tenant.raw_access.revoke",
          this.#dependencies.config.http.requestTimeoutMilliseconds,
          async (signal) => {
            const tenant = this.#tenantActor(request, request.params.tenantId, "raw.read");
            const grantId = parseRawAccessGrantId(request.params.grantId);
            if (!tenant.ok) return tenant;
            if (!grantId.ok)
              return { error: hostError("NOT_FOUND", "raw_grant_not_found"), ok: false };
            const body = await this.#json(request, signal);
            if (!body.ok) return body;
            const payload = this.#validator.validate(RawAccessGrantRevocationSchema, body.value);
            if (!payload.ok) return payload;
            const revoked = await this.#dependencies.rawAccess.revoke(
              tenant.value.tenantId,
              grantId.value,
              payload.value.expectedFence,
              {
                actorIdHash: tenant.value.actorIdHash,
                actorType: "application",
                reasonCode: "tenant_request",
              },
              signal,
            );
            if (revoked.ok) reply.code(204).send();
            return revoked;
          },
        ),
    );

    this.#server.post<{ Params: TenantParams }>(
      "/v1/tenants/:tenantId/raw-messages",
      { schema: { params: TenantParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "tenant.raw.store",
          this.#dependencies.config.http.requestTimeoutMilliseconds,
          async (signal) => {
            const tenant = this.#tenantActor(request, request.params.tenantId, "mail.submit");
            if (!tenant.ok) return tenant;
            if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "message/rfc822") {
              return {
                error: hostError("VALIDATION_FAILED", "raw_content_type_invalid"),
                ok: false,
              };
            }
            const body = asReadableBody(request.body);
            if (!body.ok) return body;
            const stored = await this.#dependencies.sdk.storeRawMessage(
              {
                body: readableByteSource(body.value),
                contentLength: requestContentLength(request.raw),
                maximumBytes: this.#dependencies.config.s3.maximumRawMessageBytes,
                purpose: "outbound_upload",
                tenantId: tenant.value.tenantId,
              },
              signal,
            );
            if (stored.ok) reply.code(201).send(stored.value);
            return stored;
          },
        ),
    );

    this.#server.post<{ Params: TenantParams }>(
      "/v1/tenants/:tenantId/outbound-intents",
      { schema: { params: TenantParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "tenant.intent.create",
          this.#dependencies.config.http.requestTimeoutMilliseconds,
          async (signal) => {
            const tenant = this.#tenantActor(request, request.params.tenantId, "mail.submit");
            if (!tenant.ok) return tenant;
            const idempotencyHeader = request.headers["idempotency-key"];
            const idempotency = parseIdempotencyKey(
              typeof idempotencyHeader === "string" ? idempotencyHeader : "",
            );
            if (!idempotency.ok) {
              return {
                error: hostError("VALIDATION_FAILED", "idempotency_key_invalid"),
                ok: false,
              };
            }
            const body = await this.#json(request, signal);
            if (!body.ok) return body;
            const payload = this.#validator.validate(OutboundIntentRequestSchema, body.value);
            if (!payload.ok) return payload;
            const raw = validateContract(RawMessageRefV1Schema, payload.value.raw);
            const envelope = validateContract(SmtpEnvelopeV1Schema, payload.value.envelope);
            if (!raw.ok || !envelope.ok) {
              return {
                error: hostError("VALIDATION_FAILED", "outbound_intent_invalid"),
                ok: false,
              };
            }
            const created = await this.#dependencies.sdk.createOutboundIntent(
              {
                envelope: envelope.value,
                idempotencyKey: idempotency.value,
                raw: raw.value,
                tenantId: tenant.value.tenantId,
                ...(payload.value.opaqueReplyToken === undefined
                  ? {}
                  : { opaqueReplyToken: payload.value.opaqueReplyToken }),
              },
              signal,
            );
            if (created.ok)
              reply.code(created.value.state === "accepted" ? 202 : 200).send(created.value);
            return created;
          },
        ),
    );

    this.#server.get<{ Params: TenantIntentParams }>(
      "/v1/tenants/:tenantId/outbound-intents/:intentId",
      { schema: { params: TenantIntentParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "tenant.intent.get",
          this.#dependencies.config.http.requestTimeoutMilliseconds,
          async (signal) => {
            const tenant = this.#tenantActor(request, request.params.tenantId, "mail.status.read");
            const intentId = parseIntentId(request.params.intentId);
            if (!tenant.ok) return tenant;
            if (!intentId.ok)
              return { error: hostError("NOT_FOUND", "intent_not_found"), ok: false };
            const found = await this.#dependencies.sdk.getOutboundIntent(
              tenant.value.tenantId,
              intentId.value,
              signal,
            );
            if (found.ok) reply.code(200).send(found.value);
            return found;
          },
        ),
    );

    this.#server.get<{ Params: TenantReceiptParams }>(
      "/v1/tenants/:tenantId/inbound-receipts/:receiptId",
      { schema: { params: TenantReceiptParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "tenant.receipt.get",
          this.#dependencies.config.http.requestTimeoutMilliseconds,
          async (signal) => {
            const tenant = this.#tenantActor(request, request.params.tenantId, "mail.status.read");
            const receiptId = parseReceiptId(request.params.receiptId);
            if (!tenant.ok) return tenant;
            if (!receiptId.ok)
              return { error: hostError("NOT_FOUND", "receipt_not_found"), ok: false };
            const found = await this.#dependencies.sdk.getInboundReceipt(
              tenant.value.tenantId,
              receiptId.value,
              signal,
            );
            if (found.ok) reply.code(200).send(found.value);
            return found;
          },
        ),
    );

    this.#server.get<{ Params: TenantBindingParams }>(
      "/v1/tenants/:tenantId/bindings/:bindingId/versions/:bindingVersion",
      { schema: { params: TenantBindingParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "tenant.binding.inspect",
          this.#dependencies.config.http.requestTimeoutMilliseconds,
          async (signal) => {
            const tenant = this.#tenantActor(request, request.params.tenantId, "bindings.read");
            const bindingId = parseBindingId(request.params.bindingId);
            const bindingVersion = Number(request.params.bindingVersion);
            if (!tenant.ok) return tenant;
            if (!bindingId.ok || !Number.isSafeInteger(bindingVersion) || bindingVersion < 1) {
              return { error: hostError("NOT_FOUND", "binding_not_found"), ok: false };
            }
            const found = await this.#dependencies.control.inspectBinding(
              tenant.value.tenantId,
              bindingId.value,
              bindingVersion,
              signal,
            );
            if (found.ok) reply.code(200).send(found.value);
            return found;
          },
        ),
    );

    this.#server.get<{ Params: TenantIntentParams }>(
      "/v1/tenants/:tenantId/outbound-intents/:intentId/quarantine",
      { schema: { params: TenantIntentParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "tenant.quarantine.outbound.inspect",
          this.#dependencies.config.http.requestTimeoutMilliseconds,
          async (signal) => {
            const tenant = this.#tenantActor(request, request.params.tenantId, "quarantine.read");
            const intentId = parseIntentId(request.params.intentId);
            if (!tenant.ok) return tenant;
            if (!intentId.ok)
              return { error: hostError("NOT_FOUND", "intent_not_found"), ok: false };
            const found = await this.#dependencies.control.inspectOutboundQuarantine(
              tenant.value.tenantId,
              intentId.value,
              signal,
            );
            if (found.ok) reply.code(200).send(found.value);
            return found;
          },
        ),
    );

    this.#server.get<{ Params: TenantReceiptParams }>(
      "/v1/tenants/:tenantId/inbound-receipts/:receiptId/quarantine",
      { schema: { params: TenantReceiptParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "tenant.quarantine.inbound.inspect",
          this.#dependencies.config.http.requestTimeoutMilliseconds,
          async (signal) => {
            const tenant = this.#tenantActor(request, request.params.tenantId, "quarantine.read");
            const receiptId = parseReceiptId(request.params.receiptId);
            if (!tenant.ok) return tenant;
            if (!receiptId.ok)
              return { error: hostError("NOT_FOUND", "receipt_not_found"), ok: false };
            const found = await this.#dependencies.control.inspectInboundQuarantine(
              tenant.value.tenantId,
              receiptId.value,
              signal,
            );
            if (found.ok) reply.code(200).send(found.value);
            return found;
          },
        ),
    );
  }

  #registerOperatorApi(): void {
    this.#server.get("/v1/operator/provider-instances", async (request, reply) =>
      this.#run(
        request,
        reply,
        "operator.provider_instances.list",
        this.#dependencies.config.http.controlPlaneTimeoutMilliseconds,
        () => {
          const actor = this.#operatorActor(request, "providers.read");
          if (!actor.ok) return Promise.resolve(actor);
          reply.code(200).send({
            providerInstances: this.#dependencies.catalog.list().map((instance) => ({
              identity: instance.identity,
              providerInstanceId: instance.providerInstanceId,
              tenantId: instance.tenantId,
            })),
          });
          return Promise.resolve({ ok: true, value: undefined });
        },
      ),
    );

    this.#server.get("/v1/operator/providers", async (request, reply) =>
      this.#run(
        request,
        reply,
        "operator.providers.list",
        this.#dependencies.config.http.controlPlaneTimeoutMilliseconds,
        () => {
          const actor = this.#operatorActor(request, "providers.read");
          if (!actor.ok) return Promise.resolve(actor);
          const registrations = this.#dependencies.registry.list().map((registration) => ({
            descriptor: registration.descriptor,
            identity: registration.identity,
          }));
          reply.code(200).send({ providers: registrations });
          return Promise.resolve({ ok: true, value: undefined });
        },
      ),
    );

    this.#server.post<{ Params: BindingLifecycleParams }>(
      "/v1/operator/tenants/:tenantId/bindings/:bindingId/versions/:bindingVersion/:action",
      { schema: { params: BindingLifecycleParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          `operator.binding.${request.params.action}`,
          this.#dependencies.config.http.controlPlaneTimeoutMilliseconds,
          async (signal) => {
            const actor = this.#operatorActor(request, "bindings.manage");
            if (!actor.ok) return actor;
            const tenantId = parseTenantId(request.params.tenantId);
            const bindingId = parseBindingId(request.params.bindingId);
            const bindingVersion = Number(request.params.bindingVersion);
            if (
              !tenantId.ok ||
              !bindingId.ok ||
              !Number.isSafeInteger(bindingVersion) ||
              bindingVersion < 1
            ) {
              return { error: hostError("NOT_FOUND", "binding_not_found"), ok: false };
            }
            const body = await this.#json(request, signal);
            if (!body.ok) return body;
            const decision = this.#validator.validate(LifecycleDecisionSchema, body.value);
            if (!decision.ok) return decision;
            const result = await this.#dependencies.control.transitionBinding(
              {
                action: request.params.action,
                actor: {
                  actorIdHash: actor.value.actorIdHash,
                  reasonCode: decision.value.reasonCode,
                },
                bindingId: bindingId.value,
                bindingVersion,
                expectedVersion: decision.value.expectedVersion,
                tenantId: tenantId.value,
              },
              signal,
            );
            if (result.ok) reply.code(200).send(result.value);
            return result;
          },
        ),
    );

    this.#server.post<{ Params: TenantIntentParams }>(
      "/v1/operator/tenants/:tenantId/outbound-intents/:intentId/quarantine-decisions",
      { schema: { params: TenantIntentParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "operator.quarantine.outbound.decide",
          this.#dependencies.config.http.controlPlaneTimeoutMilliseconds,
          async (signal) => {
            const body = await this.#json(request, signal);
            if (!body.ok) return body;
            const decision = this.#validator.validate(OutboundQuarantineDecisionSchema, body.value);
            if (!decision.ok) return decision;
            const actor = this.#operatorActor(
              request,
              decision.value.action === "authorize_retry"
                ? "quarantine.retry"
                : "quarantine.decide",
            );
            if (!actor.ok) return actor;
            const tenantId = parseTenantId(request.params.tenantId);
            const intentId = parseIntentId(request.params.intentId);
            if (!tenantId.ok || !intentId.ok) {
              return { error: hostError("NOT_FOUND", "intent_not_found"), ok: false };
            }
            const result = await this.#dependencies.control.decideOutboundQuarantine(
              {
                action: decision.value.action,
                actor: {
                  actorIdHash: actor.value.actorIdHash,
                  reasonCode: decision.value.reasonCode,
                },
                evidence: decision.value.evidence,
                expectedFence: decision.value.expectedFence,
                expectedVersion: decision.value.expectedVersion,
                intentId: intentId.value,
                tenantId: tenantId.value,
              },
              signal,
            );
            if (result.ok) reply.code(200).send(result.value);
            return result;
          },
        ),
    );

    this.#server.post<{ Params: TenantReceiptParams }>(
      "/v1/operator/tenants/:tenantId/inbound-receipts/:receiptId/quarantine-decisions",
      { schema: { params: TenantReceiptParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "operator.quarantine.inbound.decide",
          this.#dependencies.config.http.controlPlaneTimeoutMilliseconds,
          async (signal) => {
            const actor = this.#operatorActor(request, "quarantine.decide");
            if (!actor.ok) return actor;
            const tenantId = parseTenantId(request.params.tenantId);
            const receiptId = parseReceiptId(request.params.receiptId);
            if (!tenantId.ok || !receiptId.ok) {
              return { error: hostError("NOT_FOUND", "receipt_not_found"), ok: false };
            }
            const body = await this.#json(request, signal);
            if (!body.ok) return body;
            const decision = this.#validator.validate(InboundQuarantineDecisionSchema, body.value);
            if (!decision.ok) return decision;
            const result = await this.#dependencies.control.decideInboundQuarantine(
              {
                action: decision.value.action,
                actor: {
                  actorIdHash: actor.value.actorIdHash,
                  reasonCode: decision.value.reasonCode,
                },
                evidence: decision.value.evidence,
                expectedFence: decision.value.expectedFence,
                expectedVersion: decision.value.expectedVersion,
                receiptId: receiptId.value,
                tenantId: tenantId.value,
              },
              signal,
            );
            if (result.ok) reply.code(200).send(result.value);
            return result;
          },
        ),
    );

    this.#server.post<{ Params: ProviderInstanceParams }>(
      "/v1/operator/provider-instances/:providerInstanceId/bindings/plan",
      { schema: { params: ProviderInstanceParamsSchema } },
      async (request, reply) =>
        this.#control(
          request,
          reply,
          "operator.binding.plan",
          async (adapter, instance, actor, context, signal) => {
            const body = await this.#json(request, signal);
            if (!body.ok) return body;
            const desired = this.#validator.validate(DesiredBindingSchema, body.value);
            if (!desired.ok) return desired;
            const parsed = desiredBinding(desired.value);
            if (!parsed.ok) return parsed;
            const input = parsed.value;
            if (
              input.tenantId !== instance.tenantId ||
              input.providerInstanceId !== instance.providerInstanceId
            ) {
              return {
                error: hostError("AUTHORIZATION_FAILED", "control_instance_mismatch"),
                ok: false,
              };
            }
            const result: unknown = await this.#dependencies.workflow.planBinding(
              adapter,
              input,
              { ...context, actor },
              signal,
            );
            return this.#validatedWorkflowResult(result, BindingPlanSchema, reply, 200);
          },
        ),
    );

    this.#server.post<{ Params: ProviderInstanceParams }>(
      "/v1/operator/provider-instances/:providerInstanceId/plans/apply",
      { schema: { params: ProviderInstanceParamsSchema } },
      async (request, reply) =>
        this.#control(
          request,
          reply,
          "operator.binding.apply",
          async (adapter, instance, actor, context, signal) => {
            const body = await this.#json(request, signal);
            if (!body.ok) return body;
            const payload = this.#validator.validate(ApplyPlanRequestSchema, body.value);
            if (!payload.ok) return payload;
            const parsed = bindingPlan(payload.value.plan);
            if (!parsed.ok) return parsed;
            const plan = parsed.value;
            if (
              plan.identity.providerId !== instance.identity.providerId ||
              plan.identity.adapterVersion !== instance.identity.adapterVersion ||
              plan.identity.mode !== instance.identity.mode
            ) {
              return {
                error: hostError("AUTHORIZATION_FAILED", "control_instance_mismatch"),
                ok: false,
              };
            }
            const operation = this.#operation(payload.value.operation, actor, context.deadline);
            const result: unknown = await this.#dependencies.workflow.applyBindingPlan(
              adapter,
              plan,
              operation,
              { ...context, actor },
              signal,
            );
            return this.#validatedWorkflowResult(result, AppliedBindingResourcesSchema, reply, 200);
          },
        ),
    );

    this.#server.post<{ Params: ProviderInstanceParams }>(
      "/v1/operator/provider-instances/:providerInstanceId/bindings/discover",
      { schema: { params: ProviderInstanceParamsSchema } },
      async (request, reply) =>
        this.#control(
          request,
          reply,
          "operator.binding.discover",
          async (adapter, instance, actor, context, signal) => {
            const body = await this.#json(request, signal);
            if (!body.ok) return body;
            const payload = this.#validator.validate(BindingDiscoveryRequestSchema, body.value);
            if (!payload.ok) return payload;
            const parsed = validateContract(RouteBindingSnapshotV1Schema, payload.value.binding);
            if (!parsed.ok) return invalidControlInput();
            const binding = parsed.value;
            if (!exactBinding(binding, instance)) {
              return {
                error: hostError("AUTHORIZATION_FAILED", "control_instance_mismatch"),
                ok: false,
              };
            }
            const result: unknown = await this.#dependencies.workflow.discoverBinding(
              adapter,
              binding,
              { ...context, actor },
              signal,
            );
            return this.#validatedWorkflowResult(
              result,
              DiscoveredBindingResourcesSchema,
              reply,
              200,
            );
          },
        ),
    );

    this.#server.post<{ Params: ProviderInstanceParams }>(
      "/v1/operator/provider-instances/:providerInstanceId/bindings/delete",
      { schema: { params: ProviderInstanceParamsSchema } },
      async (request, reply) =>
        this.#control(
          request,
          reply,
          "operator.binding.delete",
          async (adapter, instance, actor, context, signal) => {
            const body = await this.#json(request, signal);
            if (!body.ok) return body;
            const payload = this.#validator.validate(BindingOperationRequestSchema, body.value);
            if (!payload.ok) return payload;
            const parsed = validateContract(RouteBindingSnapshotV1Schema, payload.value.binding);
            if (!parsed.ok) return invalidControlInput();
            const binding = parsed.value;
            if (!exactBinding(binding, instance)) {
              return {
                error: hostError("AUTHORIZATION_FAILED", "control_instance_mismatch"),
                ok: false,
              };
            }
            const operation = this.#operation(payload.value.operation, actor, context.deadline);
            const result: unknown = await this.#dependencies.workflow.deleteBindingResources(
              adapter,
              binding,
              operation,
              { ...context, actor },
              signal,
            );
            return this.#validatedWorkflowResult(result, DeletionEvidenceSchema, reply, 200);
          },
        ),
    );
  }

  async #control<T>(
    request: FastifyRequest<{ Params: ProviderInstanceParams }>,
    reply: FastifyReply,
    operationName: string,
    operation: (
      adapter: ProviderAdapterRegistration,
      instance: ProviderInstanceBinding,
      actor: AuthenticatedActor,
      context: Omit<ControlPlaneHandoffContext, "actor">,
      signal: AbortSignal,
    ) => Promise<Result<T, MailEdgeError>>,
  ): Promise<unknown> {
    return this.#run(
      request,
      reply,
      operationName,
      this.#dependencies.config.http.controlPlaneTimeoutMilliseconds,
      async (signal, requestId) => {
        const actor = this.#operatorActor(request, "bindings.manage");
        if (!actor.ok) return actor;
        const instance = this.#dependencies.catalog.resolveInstanceId(
          request.params.providerInstanceId,
        );
        if (!instance.ok) return instance;
        const adapter = this.#registration(instance.value);
        if (!adapter.ok) return adapter;
        if (adapter.value.controlPlane === undefined) {
          return {
            error: hostError("CAPABILITY_UNSUPPORTED", "control_plane_unavailable"),
            ok: false,
          };
        }
        return operation(
          adapter.value,
          instance.value,
          actor.value,
          Object.freeze({
            deadline: deadline(
              this.#dependencies.clock,
              this.#dependencies.config.http.controlPlaneTimeoutMilliseconds,
            ),
            instance: instance.value,
            requestId,
          }),
          signal,
        );
      },
    );
  }

  #validatedWorkflowResult<T>(
    result: unknown,
    schema: Parameters<ApiValidator["validate"]>[0],
    reply: FastifyReply,
    statusCode: number,
  ): Promise<Result<T, MailEdgeError>> {
    if (!isMailEdgeResult(result)) {
      return Promise.resolve({
        error: hostError("INTERNAL", "workflow_result_invalid"),
        ok: false,
      });
    }
    if (!result.ok) return Promise.resolve(result);
    const validated = this.#validator.validate(schema, result.value);
    if (!validated.ok) {
      return Promise.resolve({
        error: hostError("INTERNAL", "workflow_output_invalid"),
        ok: false,
      });
    }
    reply.code(statusCode).send(validated.value);
    return Promise.resolve({ ok: true, value: validated.value as T });
  }

  #operation(
    input: { readonly operationId: string; readonly reasonCode: string },
    actor: AuthenticatedActor,
    operationDeadline: string,
  ): ControlPlaneOperationContext {
    return Object.freeze({
      actorIdHash: actor.actorIdHash,
      deadline: operationDeadline,
      operationId: input.operationId,
      reasonCode: input.reasonCode,
    });
  }

  async #json(
    request: FastifyRequest,
    signal: AbortSignal,
  ): Promise<Result<unknown, MailEdgeError>> {
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
      return { error: hostError("VALIDATION_FAILED", "json_content_type_invalid"), ok: false };
    }
    const body = asReadableBody(request.body);
    if (!body.ok) return body;
    return collectBoundedJson(
      body.value,
      requestContentLength(request.raw),
      this.#dependencies.config.http.maximumJsonBytes,
      signal,
    );
  }

  #registration(
    instance: ProviderInstanceBinding,
  ): Result<ProviderAdapterRegistration, MailEdgeError> {
    const registration = this.#dependencies.registry.get(
      instance.identity.providerId,
      instance.identity.adapterVersion,
      instance.identity.mode,
    );
    return registration === undefined
      ? { error: hostError("BINDING_UNAVAILABLE", "adapter_registration_missing"), ok: false }
      : { ok: true, value: registration };
  }

  #tenantActor(
    request: FastifyRequest,
    tenantIdValue: string,
    scope: AuthScope,
  ): Result<
    AuthenticatedActor & { readonly tenantId: NonNullable<AuthenticatedActor["tenantId"]> },
    MailEdgeError
  > {
    const tenantId = parseTenantId(tenantIdValue);
    if (!tenantId.ok) return { error: hostError("NOT_FOUND", "tenant_not_found"), ok: false };
    const actor = this.#dependencies.authenticator.authenticate(
      request.headers.authorization,
      "tenant",
      scope,
      tenantId.value,
    );
    return !actor.ok || actor.value.tenantId === undefined
      ? (actor as Result<never, MailEdgeError>)
      : { ok: true, value: { ...actor.value, tenantId: actor.value.tenantId } };
  }

  #operatorActor(
    request: FastifyRequest,
    scope: AuthScope,
  ): Result<AuthenticatedActor, MailEdgeError> {
    return this.#dependencies.authenticator.authenticate(
      request.headers.authorization,
      "operator",
      scope,
    );
  }

  async #run<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    operationName: string,
    timeoutMilliseconds: number,
    operation: RequestOperation<T>,
  ): Promise<unknown> {
    const scope = new RequestAbortScope(
      request.raw,
      this.#dependencies.shutdownSignal,
      timeoutMilliseconds,
    );
    const lease = await this.#dependencies.gate.acquire(scope.signal);
    if (!lease.ok) {
      scope.close();
      return this.#sendProblem(reply, request, lease.error);
    }
    const startedAt = Date.now();
    try {
      const result = await this.#dependencies.tracer.withSpan(
        operationName,
        Object.freeze({
          "http.request.method": request.method,
          "mail_edge.operation": operationName,
        }),
        () => operation(scope.signal, request.id),
      );
      request.log.info({
        durationMilliseconds: Date.now() - startedAt,
        event: "http.request_completed",
        operation: operationName,
        outcome: result.ok ? "success" : "failure",
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
      if (!result.ok) {
        return reply.sent ? await reply : await this.#sendProblem(reply, request, result.error);
      }
      if (reply.sent) return await reply;
      return undefined;
    } finally {
      scope.close();
      lease.value.release();
    }
  }

  #sendProblem(reply: FastifyReply, request: FastifyRequest, error: MailEdgeError): FastifyReply {
    if (error.code === "AUTHENTICATION_FAILED" || error.code === "AUTHORIZATION_FAILED") {
      const surface = request.url.startsWith("/v1/providers/")
        ? "provider_ingress"
        : request.url.startsWith("/v1/raw-access-grants/")
          ? "raw_access"
          : "host_api";
      this.#dependencies.metrics.recordSecurityRejection(
        surface,
        error.code === "AUTHENTICATION_FAILED" ? "authentication_failed" : "authorization_failed",
      );
    }
    const traceId = this.#dependencies.tracer.activeSpan()?.spanContext().traceId;
    const problem = projectProblem(error, {
      instance: request.id,
      occurredAt: this.#dependencies.clock.now(),
      ...(traceId === undefined ? {} : { traceId }),
    });
    return reply
      .code(problem.status)
      .header("content-type", "application/problem+json; charset=utf-8")
      .send(problem);
  }
}
