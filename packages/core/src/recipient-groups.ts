import { MailEdgeError, type Result, type SmtpEnvelopeV1 } from "@mail-edge/contracts";

import { canonicalJson, sha256Text } from "./canonical-json.js";
import type { CanonicalSmtpEnvelope } from "./envelope.js";

/** @public */
export interface RecipientGroupingCapabilities {
  readonly maxRecipientsPerTransaction: number;
  readonly perRecipientDsn: boolean;
  readonly perRecipientOriginalRecipient: boolean;
}

/** @public */
export interface RecipientGroup {
  readonly groupId: string;
  readonly recipientIndexes: readonly number[];
  readonly envelope: SmtpEnvelopeV1;
}

const groupFailure = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "CAPABILITY_UNSUPPORTED",
    deliveryCertainty: "not_sent",
    message: `Recipients cannot be grouped for this transport: ${reason}`,
    retryable: false,
    safeDetails: { capability: reason },
  });

/** Partitions recipients into deterministic transport-expressible certainty boundaries. @public */
export const groupRecipientsForTransport = (
  canonical: CanonicalSmtpEnvelope,
  capabilities: RecipientGroupingCapabilities,
): Result<readonly RecipientGroup[], MailEdgeError> => {
  if (
    !Number.isSafeInteger(capabilities.maxRecipientsPerTransaction) ||
    capabilities.maxRecipientsPerTransaction < 1
  ) {
    return { error: groupFailure("max_recipients"), ok: false };
  }

  const buckets = new Map<string, number[]>();
  canonical.recipients.forEach((recipient, index) => {
    const dsn = recipient.dsn;
    const key = canonicalJson({
      envelopeId: canonical.wire.dsn?.envelopeId ?? null,
      notify: capabilities.perRecipientDsn ? null : (dsn?.notify ?? null),
      originalRecipient: capabilities.perRecipientOriginalRecipient
        ? null
        : (dsn?.originalRecipient ?? null),
      ret: canonical.wire.dsn?.ret ?? null,
    });
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [index]);
    } else {
      bucket.push(index);
    }
  });

  const groups: RecipientGroup[] = [];
  for (const [, indexes] of [...buckets.entries()].toSorted(
    (left, right) =>
      (left[1][0] ?? Number.MAX_SAFE_INTEGER) - (right[1][0] ?? Number.MAX_SAFE_INTEGER),
  )) {
    for (
      let offset = 0;
      offset < indexes.length;
      offset += capabilities.maxRecipientsPerTransaction
    ) {
      const recipientIndexes = Object.freeze(
        indexes.slice(offset, offset + capabilities.maxRecipientsPerTransaction),
      );
      const rcptTo = Object.freeze(
        recipientIndexes.map((index) => {
          const recipient = canonical.wire.rcptTo[index];
          if (recipient === undefined) {
            throw new RangeError("Recipient group index is outside the canonical envelope.");
          }
          return recipient;
        }),
      );
      const envelope = Object.freeze({ ...canonical.wire, rcptTo });
      groups.push(
        Object.freeze({
          envelope,
          groupId: sha256Text(canonicalJson(envelope)),
          recipientIndexes,
        }),
      );
    }
  }
  return { ok: true, value: Object.freeze(groups) };
};
