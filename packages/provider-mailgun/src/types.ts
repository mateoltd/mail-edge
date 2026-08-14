import type {
  Clock,
  MailEdgeError,
  ProviderInstanceId,
  Result,
  RouteBindingSnapshotV1,
  SecretResolver,
} from "@mail-edge/provider";

/** Mailgun data plane and control plane region. @public */
export type MailgunRegion = "eu" | "us";

/** Non-secret, persistable configuration for one Mailgun adapter registration. @public */
export interface MailgunProviderConfig {
  /** Mailgun account region used for both API and SMTP endpoints. */
  readonly region: MailgunRegion;
  /** Opaque SecretResolver reference for the Mailgun private API key. */
  readonly apiKeySecretReference: string;
  /** Opaque SecretResolver reference for the per-domain SMTP password. */
  readonly smtpPasswordSecretReference: string;
  /** Opaque SecretResolver reference for Mailgun's webhook signing key. */
  readonly webhookSigningKeySecretReference: string;
  /** Local part of the per-domain SMTP login. */
  readonly smtpUsernameLocalPart: string;
  /** Host-owned path that dispatches raw-MIME route posts to this adapter. */
  readonly inboundPath: string;
  /** Exact inbound snapshots eligible for binding-hint resolution. */
  readonly inboundBindings: readonly RouteBindingSnapshotV1[];
  /** Public HTTPS Mailgun route target, with the same path as inboundPath. */
  readonly inboundForwardUrl: string;
  /** Mailgun account-global route priority. */
  readonly routePriority: number;
  /** Maximum accepted timestamp skew for signed route and webhook requests. */
  readonly signatureToleranceSeconds: number;
  /** Finite timeout applied to each provider network operation. */
  readonly networkTimeoutMilliseconds: number;
}

/** Atomic replay outcome for one verified Mailgun webhook token. @public */
export type MailgunReplayOutcome = "new" | "duplicate" | "conflict";

/** Durable, provider-instance-scoped token consumption required by feedback ingress. @public */
export interface MailgunWebhookReplayStore {
  /** Atomically records or compares one provider-instance-scoped signed token. */
  consume(
    input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly nonceDigest: string;
      readonly bodyDigest: string;
      readonly expiresAt: string;
    },
    signal: AbortSignal,
  ): Promise<Result<MailgunReplayOutcome, MailEdgeError>>;
}

/** Bounded HTTP request owned by the Mailgun package. @public */
export interface MailgunHttpRequest {
  /** Exact Mailgun API URL. */
  readonly url: URL;
  /** Supported Mailgun API method. */
  readonly method: "DELETE" | "GET" | "POST";
  /** Complete request headers, including resolved authorization. */
  readonly headers: Readonly<Record<string, string>>;
  /** Optional finite request body. */
  readonly body?: Uint8Array;
  /** Maximum response bytes accepted from the transport. */
  readonly maximumResponseBytes: number;
  /** Finite request timeout. */
  readonly timeoutMilliseconds: number;
}

/** Bounded HTTP response returned by an injected transport. @public */
export interface MailgunHttpResponse {
  /** HTTP status code returned by Mailgun. */
  readonly statusCode: number;
  /** Lowercase response-header snapshot. */
  readonly headers: Readonly<Record<string, string>>;
  /** Bounded response body. */
  readonly body: Uint8Array;
}

/** Injectable HTTP transport used for deterministic qualification and native production I/O. @public */
export interface MailgunHttpTransport {
  /** Executes one bounded HTTPS request without redirect or retry behavior. */
  request(
    request: MailgunHttpRequest,
    signal: AbortSignal,
  ): Promise<Result<MailgunHttpResponse, MailEdgeError>>;
}

/** One bounded SMTP response. @public */
export interface MailgunSmtpResponse {
  /** Three-digit SMTP response code. */
  readonly code: number;
  /** Bounded response text with the SMTP code and separator removed. */
  readonly lines: readonly string[];
}

/** One TLS-protected Mailgun SMTP session. @public */
export interface MailgunSmtpSession {
  /** Reads one complete bounded SMTP response. */
  readResponse(signal: AbortSignal): Promise<Result<MailgunSmtpResponse, MailEdgeError>>;
  /** Writes one CRLF-terminated SMTP command. */
  writeCommand(command: string, signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
  /** Writes confirmed SMTP DATA bytes. */
  writeData(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
  /** Closes this attempt-owned SMTP session. */
  close(): Promise<void>;
}

/** Injectable connector used to create one Mailgun SMTP session per dispatch attempt. @public */
export interface MailgunSmtpConnector {
  /** Opens one verified TLS-on-connect Mailgun SMTP session. */
  connect(
    input: {
      readonly host: string;
      readonly port: 465;
      readonly timeoutMilliseconds: number;
    },
    signal: AbortSignal,
  ): Promise<Result<MailgunSmtpSession, MailEdgeError>>;
}

/** Explicit infrastructure dependencies; secret values are supplied only by the resolver. @public */
export interface MailgunProviderDependencies {
  /** Secret resolver used only at the point of provider I/O or verification. */
  readonly secrets: SecretResolver;
  /** Host clock used for signature windows, evidence, and control plans. */
  readonly clock: Clock;
  /** Durable atomic replay store for feedback webhook tokens. */
  readonly webhookReplay: MailgunWebhookReplayStore;
  /** Optional deterministic or host-specific HTTP transport. */
  readonly httpTransport?: MailgunHttpTransport;
  /** Optional deterministic or host-specific SMTP connector. */
  readonly smtpConnector?: MailgunSmtpConnector;
}
