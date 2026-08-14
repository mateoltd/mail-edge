import type {
  MailEdgeError,
  RawMessageRefV1,
  Result,
  SmtpEnvelopeV1,
  TenantId,
} from "@mail-edge/contracts";
import {
  DerivedMessageService,
  ReverseAliasHeaderPatchPlanner,
  ReverseRoutePlanningService,
  type BlobStorePort,
  type Clock,
  type DerivedBlobProvenancePort,
  type HeaderPatchApplierPort,
  type IdGenerator,
  type ReverseRouteResolver,
  type TenantUnitOfWorkFactory,
} from "@mail-edge/core";
import type { ReverseRoutePreparationPort } from "@mail-edge/runtime";

/** Resolves an opaque host reply token and streams the authorized header patch. */
export class HostReverseRoutePreparationService implements ReverseRoutePreparationPort {
  readonly #applier: HeaderPatchApplierPort;
  readonly #blobStore: BlobStorePort;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #planner: ReverseRoutePlanningService;
  readonly #provenance: DerivedBlobProvenancePort;
  readonly #transactions: TenantUnitOfWorkFactory;

  constructor(input: {
    readonly applier: HeaderPatchApplierPort;
    readonly blobStore: BlobStorePort;
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly provenance: DerivedBlobProvenancePort;
    readonly resolver: ReverseRouteResolver;
    readonly transactions: TenantUnitOfWorkFactory;
  }) {
    this.#applier = input.applier;
    this.#blobStore = input.blobStore;
    this.#clock = input.clock;
    this.#ids = input.ids;
    this.#planner = new ReverseRoutePlanningService(
      input.resolver,
      new ReverseAliasHeaderPatchPlanner(),
    );
    this.#provenance = input.provenance;
    this.#transactions = input.transactions;
  }

  async prepare(
    input: {
      readonly tenantId: TenantId;
      readonly raw: RawMessageRefV1;
      readonly envelope: SmtpEnvelopeV1;
      readonly opaqueReplyToken: string;
    },
    signal: AbortSignal,
  ): Promise<
    Result<
      {
        readonly envelope: SmtpEnvelopeV1;
        readonly transmissionRaw: RawMessageRefV1;
        readonly planDigest: string;
      },
      MailEdgeError
    >
  > {
    const plan = await this.#planner.resolveAndPlan(input, signal);
    if (!plan.ok) return plan;
    const derived = await new DerivedMessageService({
      applier: this.#applier,
      blobStore: this.#blobStore,
      clock: this.#clock,
      ids: this.#ids,
      provenance: this.#provenance,
      unitOfWork: this.#transactions.forTenant(input.tenantId),
    }).materialize(
      { patchPlan: plan.value.patchPlan, source: input.raw, tenantId: input.tenantId },
      signal,
    );
    return derived.ok
      ? {
          ok: true,
          value: Object.freeze({
            envelope: plan.value.resolution.envelope,
            planDigest: plan.value.planDigest,
            transmissionRaw: derived.value,
          }),
        }
      : derived;
  }
}
