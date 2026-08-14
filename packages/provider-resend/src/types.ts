import type {
  BlobStagePort,
  Clock,
  InboundIngressCommit,
  MailEdgeError,
  ProviderId,
  ProviderInstanceId,
  ProviderReplayIdentityV1,
  RawMessageRefV1,
  ReceiptId,
  Result,
  RouteBindingSnapshotV1,
  SecretResolver,
  SmtpEnvelopeV1,
  TenantId,
} from "@mail-edge/provider";

import type { ResendFeedbackEvent } from "./constants.js";

/** Resend domain region accepted by the current Domains API. @public */
export type ResendRegion = "ap-northeast-1" | "eu-west-1" | "sa-east-1" | "us-east-1";

/** Non-secret, persistable configuration for one Resend adapter registration. @public */
export interface ResendProviderConfig {
  /** Opaque SecretResolver reference for the least-privilege Resend API key. */
  readonly apiKeySecretReference: string;
  /** Current then previous signing-secret references for the inbound endpoint. */
  readonly inboundWebhookSecretReferences: readonly [string, ...string[]];
  /** Current then previous signing-secret references for the feedback endpoint. */
  readonly feedbackWebhookSecretReferences: readonly [string, ...string[]];
  /** Write-only destination for a newly created inbound webhook secret. */
  readonly inboundWebhookSecretDestination: string;
  /** Write-only destination for a newly created feedback webhook secret. */
  readonly feedbackWebhookSecretDestination: string;
  /** Exact host-owned path for email.received events. */
  readonly inboundPath: string;
  /** Exact host-owned path for transport and complaint events. */
  readonly feedbackPath: string;
  /** Public HTTPS endpoint registered for email.received. */
  readonly inboundWebhookEndpoint: string;
  /** Public HTTPS endpoint registered for transport and complaint events. */
  readonly feedbackWebhookEndpoint: string;
  /** Exact inbound binding snapshots eligible for binding-hint resolution. */
  readonly inboundBindings: readonly RouteBindingSnapshotV1[];
  /** Exact qualified hosts for signed raw-message URLs returned by Resend. */
  readonly rawDownloadAllowedHosts: readonly [string, ...string[]];
  /** Sending and receiving domain region. */
  readonly region: ResendRegion;
  /** Public DNS name used in SMTP EHLO. */
  readonly smtpEhloName: string;
  /** Finite timeout for each provider network operation. */
  readonly networkTimeoutMilliseconds: number;
  /** Durable replay retention covering provider retries and manual replays. */
  readonly webhookReplayTtlSeconds: number;
  /** Per-process bound for simultaneous Resend API calls. */
  readonly maximumApiConcurrency: number;
  /** Per-process bound for queued Resend API calls. */
  readonly maximumApiQueueDepth: number;
  /** Per-process bound for simultaneous raw acquisitions. */
  readonly maximumRawAcquisitionConcurrency: number;
  /** Per-process bound for queued raw acquisitions. */
  readonly maximumRawAcquisitionQueueDepth: number;
  /** Per-process bound for simultaneous SMTP transactions. */
  readonly maximumSmtpConcurrency: number;
  /** Per-process bound for queued SMTP transactions. */
  readonly maximumSmtpQueueDepth: number;
}

/** Durable atomic replay outcome for one verified svix-id. @public */
export type ResendReplayOutcome = "conflict" | "duplicate" | "new";

/** Durable provider-instance-scoped replay store required by feedback ingress. @public */
export interface ResendWebhookReplayStore {
  consume(
    input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly nonceDigest: string;
      readonly bodyDigest: string;
      readonly expiresAt: string;
    },
    signal: AbortSignal,
  ): Promise<Result<ResendReplayOutcome, MailEdgeError>>;
}

/** Authenticated metadata committed before a Resend raw object is acquired. @public */
export interface ResendInboundMetadataCommitInput {
  readonly schemaVersion: "v1";
  readonly tenantId: TenantId;
  readonly providerId: ProviderId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerReceiptKey: string;
  readonly receivedEmailId: string;
  readonly binding: RouteBindingSnapshotV1;
  readonly verificationEvidenceDigest: string;
  readonly receivedAt: string;
  readonly replay: ProviderReplayIdentityV1;
}

/** Immutable acquisition claim loaded by a worker from durable receipt state. @public */
export interface ResendInboundAcquisitionClaim {
  readonly schemaVersion: "v1";
  readonly receiptId: ReceiptId;
  readonly tenantId: TenantId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly receivedEmailId: string;
  readonly binding: RouteBindingSnapshotV1;
}

/** Narrow state port for the required received, acquiring, stored workflow. @public */
export interface ResendInboundMetadataPort {
  commitAuthenticatedMetadata(
    input: ResendInboundMetadataCommitInput,
    signal: AbortSignal,
  ): Promise<Result<InboundIngressCommit, MailEdgeError>>;
  claimAcquisition(
    input: {
      readonly receiptId: ReceiptId;
      readonly providerInstanceId: ProviderInstanceId;
    },
    signal: AbortSignal,
  ): Promise<Result<ResendInboundAcquisitionClaim, MailEdgeError>>;
  commitAcquiredRaw(
    input: {
      readonly receiptId: ReceiptId;
      readonly raw: RawMessageRefV1;
      readonly envelope: SmtpEnvelopeV1;
      readonly retrievalEvidenceDigest: string;
    },
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
  recordAcquisitionFailure(
    input: {
      readonly receiptId: ReceiptId;
      readonly disposition: "quarantine" | "retry_wait";
      readonly errorCode: MailEdgeError["code"];
    },
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
}

/** Write-only destination for a webhook secret returned once by the control plane. @public */
export interface ResendWebhookSecretSink {
  store(
    destination: string,
    secret: Uint8Array,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
}

/** One bounded Resend API request. @public */
export interface ResendHttpRequest {
  readonly url: URL;
  readonly method: "DELETE" | "GET" | "PATCH" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly maximumResponseBytes: number;
  readonly timeoutMilliseconds: number;
}

/** One bounded Resend API response. @public */
export interface ResendHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/** Injectable bounded transport for the fixed Resend API origin. @public */
export interface ResendHttpTransport {
  request(
    request: ResendHttpRequest,
    signal: AbortSignal,
  ): Promise<Result<ResendHttpResponse, MailEdgeError>>;
}

/** One resolved address used to pin a raw download connection. @public */
export interface ResendResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Cancellation-aware DNS dependency used by the SSRF-resistant raw transport. @public */
export interface ResendDnsResolver {
  resolve(
    hostname: string,
    signal: AbortSignal,
  ): Promise<Result<readonly ResendResolvedAddress[], MailEdgeError>>;
}

/** Streaming response from an allowlisted, DNS-pinned raw-message URL. @public */
export interface ResendRawDownloadResponse {
  readonly statusCode: number;
  readonly contentLength: number | null;
  readonly contentType: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
}

/** Request to Resend's short-lived signed raw-message object. @public */
export interface ResendRawDownloadRequest {
  readonly url: URL;
  readonly allowedHosts: readonly string[];
  readonly maximumBytes: number;
  readonly timeoutMilliseconds: number;
}

/** Injectable no-redirect, SSRF-resistant streaming raw-message transport. @public */
export interface ResendRawDownloadTransport {
  open(
    request: ResendRawDownloadRequest,
    signal: AbortSignal,
  ): Promise<Result<ResendRawDownloadResponse, MailEdgeError>>;
}

/** One bounded SMTP response. @public */
export interface ResendSmtpResponse {
  readonly code: number;
  readonly lines: readonly string[];
}

/** One attempt-owned TLS-protected SMTP session. @public */
export interface ResendSmtpSession {
  readResponse(signal: AbortSignal): Promise<Result<ResendSmtpResponse, MailEdgeError>>;
  writeCommand(command: string, signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
  writeData(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
}

/** Injectable connector for one Resend SMTPS session per attempt. @public */
export interface ResendSmtpConnector {
  connect(
    input: {
      readonly host: string;
      readonly port: number;
      readonly timeoutMilliseconds: number;
    },
    signal: AbortSignal,
  ): Promise<Result<ResendSmtpSession, MailEdgeError>>;
}

/** Constructor-injected infrastructure dependencies. @public */
export interface ResendProviderDependencies {
  readonly secrets: SecretResolver;
  readonly clock: Clock;
  readonly stages: BlobStagePort;
  readonly inboundMetadata: ResendInboundMetadataPort;
  readonly webhookReplay: ResendWebhookReplayStore;
  readonly webhookSecretSink: ResendWebhookSecretSink;
  readonly httpTransport?: ResendHttpTransport;
  readonly rawDownloadTransport?: ResendRawDownloadTransport;
  readonly smtpConnector?: ResendSmtpConnector;
}

/** Bounded DNS record returned by Resend domain create/discovery APIs. @public */
export interface ResendDnsRecord {
  readonly record: string;
  readonly name: string;
  readonly type: "CAA" | "CNAME" | "MX" | "TXT";
  readonly ttl: string;
  readonly status: string;
  readonly value: string;
  readonly priority?: number;
}

/** Parsed, verified Resend webhook metadata. @internal */
export interface VerifiedResendWebhook {
  readonly eventId: string;
  readonly timestampSeconds: number;
  readonly bodyDigest: string;
  readonly nonceDigest: string;
  readonly expiresAt: string;
  readonly body: Uint8Array;
}

/** Current received-email API subset consumed by raw acquisition. @internal */
export interface ResendReceivedEmail {
  readonly id: string;
  readonly createdAt: string;
  readonly from: string;
  readonly receivedFor: readonly string[];
  readonly messageId: string;
  readonly raw: {
    readonly downloadUrl: string;
    readonly expiresAt: string;
  };
}

/** Current provider feedback wire subset after structural validation. @internal */
export interface ResendFeedbackWireEvent {
  readonly type: ResendFeedbackEvent;
  readonly createdAt: string;
  readonly emailId: string;
  readonly messageId: string;
  readonly recipients: readonly string[];
  readonly bounceType?: string;
  readonly bounceSubType?: string;
  readonly failureReason?: string;
  readonly suppressionType?: string;
}
