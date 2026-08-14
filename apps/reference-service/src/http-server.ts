import { randomUUID } from "node:crypto";

import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import {
  MailEdgeError,
  parseIdempotencyKey,
  parseIntentId,
  parseReceiptId,
  parseTenantId,
  projectProblem,
  RawMessageRefV1Schema,
  SmtpEnvelopeV1Schema,
  type Result,
  type ProviderFeedbackV1,
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
  type InboundIngressCommit,
  type ProviderAdapterRegistry,
  type RouteBindingSnapshotV1,
} from "@mail-edge/provider";
import type { MailEdgeSdk } from "@mail-edge/sdk";
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
  BindingDiscoveryRequestSchema,
  BindingOperationRequestSchema,
  BindingPlanSchema,
  DeletionEvidenceSchema,
  DesiredBindingSchema,
  DiscoveredBindingResourcesSchema,
  FeedbackHandoffResultSchema,
  OutboundIntentRequestSchema,
  ProviderInstanceParamsSchema,
  ProviderRouteParamsSchema,
  TenantIntentParamsSchema,
  TenantParamsSchema,
  TenantReceiptParamsSchema,
  type ProviderInstanceParams,
  type ProviderRouteParams,
  type TenantIntentParams,
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
  ControlPlaneHandoffContext,
  ProviderInstanceBinding,
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
import type { HostTracer } from "./telemetry.js";
import type { Clock } from "@mail-edge/core";

interface HttpDependencies {
  readonly authenticator: StaticTokenAuthenticator;
  readonly catalog: ProviderInstanceCatalog;
  readonly clock: Clock;
  readonly config: ReferenceServiceConfig;
  readonly gate: BoundedConcurrencyGate;
  readonly readiness: (signal: AbortSignal) => Promise<Result<void, MailEdgeError>>;
  readonly registry: ProviderAdapterRegistry;
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

const isMailEdgeResult = <T>(value: unknown): value is Result<T, MailEdgeError> => {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if (value.ok === true) return "value" in value;
  return value.ok === false && "error" in value && value.error instanceof MailEdgeError;
};

const errorCode = (error: FastifyError): string | undefined =>
  "code" in error && typeof error.code === "string" ? error.code : undefined;

export class ReferenceHttpServer implements LifecycleComponent {
  readonly name = "http";
  readonly #dependencies: HttpDependencies;
  readonly #server: FastifyInstance;
  readonly #validator = new ApiValidator();
  #address: string | undefined;

  constructor(dependencies: HttpDependencies) {
    this.#dependencies = dependencies;
    const server = fastify({
      bodyLimit: dependencies.config.http.maximumIngressBytes,
      forceCloseConnections: "idle",
      genReqId: () => randomUUID(),
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

    this.#registerProviderIngress();
    this.#registerTenantApi();
    this.#registerOperatorApi();
  }

  #registerProviderIngress(): void {
    const base = "/v1/providers/:providerId/:adapterVersion/:mode/instances/:providerInstanceId";
    this.#server.post<{ Params: ProviderRouteParams }>(
      `${base}/inbound`,
      { schema: { params: ProviderRouteParamsSchema } },
      async (request, reply) =>
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
            const context = Object.freeze({
              deadline: deadline(
                this.#dependencies.clock,
                this.#dependencies.config.http.requestTimeoutMilliseconds,
              ),
              providerInstanceId: resolved.value.providerInstanceId,
              requestId,
            });
            const result: unknown = await new ProviderInboundIngressService(
              registration.value.inbound,
              bindInboundServices(resolved.value, services.value),
            ).execute(
              providerHttpRequest({
                body: body.value,
                path: request.raw.url?.split("?", 1)[0] ?? "/",
                raw: request.raw,
                receivedAt: this.#dependencies.clock.now(),
              }),
              context,
              signal,
            );
            if (!isMailEdgeResult<InboundIngressCommit>(result)) {
              return { error: hostError("INTERNAL", "adapter_result_invalid"), ok: false };
            }
            if (result.ok) reply.code(result.value.response.statusCode).send();
            return result;
          },
        ),
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
            if (!isMailEdgeResult<readonly ProviderFeedbackV1[]>(result)) {
              return { error: hostError("INTERNAL", "adapter_result_invalid"), ok: false };
            }
            if (!result.ok) return result;
            const handoff: unknown = await this.#dependencies.workflow.commitFeedback(
              {
                events: result.value,
                instance: resolved.value,
                receivedAt: this.#dependencies.clock.now(),
                requestId,
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
      "/v1/tenants/:tenantId/raw-messages",
      { schema: { params: TenantParamsSchema } },
      async (request, reply) =>
        this.#run(
          request,
          reply,
          "tenant.raw.store",
          this.#dependencies.config.http.requestTimeoutMilliseconds,
          async (signal) => {
            const tenant = this.#tenantActor(request, request.params.tenantId);
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
                maximumBytes: this.#dependencies.config.http.maximumIngressBytes,
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
            const tenant = this.#tenantActor(request, request.params.tenantId);
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
            const tenant = this.#tenantActor(request, request.params.tenantId);
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
            const tenant = this.#tenantActor(request, request.params.tenantId);
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
  }

  #registerOperatorApi(): void {
    this.#server.get("/v1/operator/providers", async (request, reply) =>
      this.#run(
        request,
        reply,
        "operator.providers.list",
        this.#dependencies.config.http.controlPlaneTimeoutMilliseconds,
        () => {
          const actor = this.#operatorActor(request);
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
            const input = desired.value as unknown as DesiredBindingV1;
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
            const plan = payload.value.plan as unknown as BindingPlanV1;
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
            const binding = payload.value.binding as unknown as RouteBindingSnapshotV1;
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
            const binding = payload.value.binding as unknown as RouteBindingSnapshotV1;
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
        const actor = this.#operatorActor(request);
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
  ): Result<
    AuthenticatedActor & { readonly tenantId: NonNullable<AuthenticatedActor["tenantId"]> },
    MailEdgeError
  > {
    const tenantId = parseTenantId(tenantIdValue);
    if (!tenantId.ok) return { error: hostError("NOT_FOUND", "tenant_not_found"), ok: false };
    const actor = this.#dependencies.authenticator.authenticate(
      request.headers.authorization,
      "tenant",
      tenantId.value,
    );
    return !actor.ok || actor.value.tenantId === undefined
      ? (actor as Result<never, MailEdgeError>)
      : { ok: true, value: { ...actor.value, tenantId: actor.value.tenantId } };
  }

  #operatorActor(request: FastifyRequest): Result<AuthenticatedActor, MailEdgeError> {
    return this.#dependencies.authenticator.authenticate(request.headers.authorization, "operator");
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
      if (!result.ok) return await this.#sendProblem(reply, request, result.error);
      if (reply.sent) return await reply;
      return undefined;
    } finally {
      scope.close();
      lease.value.release();
    }
  }

  #sendProblem(reply: FastifyReply, request: FastifyRequest, error: MailEdgeError): FastifyReply {
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
