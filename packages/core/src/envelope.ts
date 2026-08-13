import { domainToASCII } from "node:url";

import {
  createContractValidator,
  MailEdgeError,
  type DsnNotify,
  type Result,
  SmtpEnvelopeV1Schema,
  type SmtpEnvelopeV1,
  type SmtpRecipientV1,
} from "@mail-edge/contracts";

/** @public */
export interface CanonicalMailbox {
  readonly address: string;
  readonly localPart: string;
  readonly domainALabel: string;
  readonly comparisonKey: string;
  readonly requiresSmtpUtf8: boolean;
}

/** @public */
export interface CanonicalSmtpRecipient {
  readonly mailbox: CanonicalMailbox;
  readonly dsn?: SmtpRecipientV1["dsn"];
}

/** @public */
export interface CanonicalSmtpEnvelope {
  readonly wire: SmtpEnvelopeV1;
  readonly mailFrom: CanonicalMailbox | null;
  readonly recipients: readonly CanonicalSmtpRecipient[];
}

const asciiAtext = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]$/u;
const domainExpression =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;
const notifyOrder = Object.freeze({ delay: 2, failure: 1, success: 0 });

const validationFailure = (field: string, reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "VALIDATION_FAILED",
    deliveryCertainty: "not_sent",
    message: `Invalid SMTP envelope field ${field}: ${reason}`,
    retryable: false,
    safeDetails: { field, reason },
  });

const splitMailbox = (address: string): readonly [string, string] | null => {
  let quoted = false;
  let escaped = false;
  let separator = -1;
  for (let index = 0; index < address.length; index += 1) {
    const character = address.charAt(index);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === "@") {
      if (separator !== -1) {
        return null;
      }
      separator = index;
    }
  }
  if (quoted || escaped || separator <= 0 || separator >= address.length - 1) {
    return null;
  }
  return [address.slice(0, separator), address.slice(separator + 1)];
};

const validQuotedLocalPart = (localPart: string): boolean => {
  if (!localPart.startsWith('"') || !localPart.endsWith('"') || localPart.length < 2) {
    return false;
  }
  let escaped = false;
  const content = localPart.slice(1, -1);
  for (const character of content) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return false;
    if (escaped) {
      if (codePoint < 32 || codePoint === 127) {
        return false;
      }
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"' || codePoint < 32 || codePoint === 127) {
      return false;
    }
  }
  return !escaped;
};

const validDotAtomLocalPart = (localPart: string): boolean => {
  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) {
    return false;
  }
  for (const character of localPart) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return false;
    if (character === ".") {
      continue;
    }
    if (codePoint < 128) {
      if (!asciiAtext.test(character)) {
        return false;
      }
    } else if (/\p{Cc}|\p{Cs}|\p{Z}/u.test(character)) {
      return false;
    }
  }
  return localPart.length > 0;
};

/** Strictly parses and canonicalizes one SMTP mailbox without changing local-part bytes. @public */
export const canonicalizeMailbox = (address: string): Result<CanonicalMailbox, MailEdgeError> => {
  if (address.includes("\r") || address.includes("\n") || address.includes("\0")) {
    return { error: validationFailure("mailbox", "control_character"), ok: false };
  }
  const split = splitMailbox(address);
  if (split === null) {
    return { error: validationFailure("mailbox", "invalid_addr_spec"), ok: false };
  }
  const [localPart, domain] = split;
  if (
    Buffer.byteLength(localPart, "utf8") > 64 ||
    !(validQuotedLocalPart(localPart) || validDotAtomLocalPart(localPart))
  ) {
    return { error: validationFailure("localPart", "invalid_or_too_long"), ok: false };
  }
  if (domain.endsWith(".") || domain.includes("*") || domain.startsWith("[")) {
    return { error: validationFailure("domain", "non_canonical_domain"), ok: false };
  }
  const domainALabel = domainToASCII(domain).toLowerCase();
  if (
    domainALabel.length === 0 ||
    domainALabel.length > 253 ||
    !domainExpression.test(domainALabel)
  ) {
    return { error: validationFailure("domain", "invalid_idna_domain"), ok: false };
  }
  const canonicalAddress = `${localPart}@${domainALabel}`;
  if (Buffer.byteLength(canonicalAddress, "utf8") > 254) {
    return { error: validationFailure("mailbox", "mailbox_too_long"), ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({
      address: canonicalAddress,
      comparisonKey: canonicalAddress,
      domainALabel,
      localPart,
      requiresSmtpUtf8: Array.from(localPart, (character) => character.codePointAt(0) ?? 0).some(
        (codePoint) => codePoint > 127,
      ),
    }),
  };
};

const canonicalizeNotify = (notify: DsnNotify | undefined): DsnNotify | undefined => {
  if (notify === undefined || notify[0] === "never") {
    return notify;
  }
  return Object.freeze(
    [...notify].toSorted((left, right) => notifyOrder[left] - notifyOrder[right]),
  ) as DsnNotify;
};

const canonicalizeRecipient = (
  recipient: SmtpRecipientV1,
): Result<CanonicalSmtpRecipient, MailEdgeError> => {
  const mailbox = canonicalizeMailbox(recipient.address);
  if (!mailbox.ok) {
    return mailbox;
  }
  const notify = canonicalizeNotify(recipient.dsn?.notify as DsnNotify | undefined);
  const dsn =
    recipient.dsn === undefined
      ? undefined
      : Object.freeze({
          ...(notify === undefined ? {} : { notify }),
          ...(recipient.dsn.originalRecipient === undefined
            ? {}
            : { originalRecipient: recipient.dsn.originalRecipient }),
        });
  return {
    ok: true,
    value: Object.freeze({ mailbox: mailbox.value, ...(dsn === undefined ? {} : { dsn }) }),
  };
};

/** Validates all envelope semantics and returns a stable canonical wire representation. @public */
export const canonicalizeSmtpEnvelope = (
  input: unknown,
): Result<CanonicalSmtpEnvelope, MailEdgeError> => {
  const boundary = createContractValidator().validate(SmtpEnvelopeV1Schema, input);
  if (!boundary.ok) {
    return {
      error: new MailEdgeError({
        code: "VALIDATION_FAILED",
        deliveryCertainty: "not_sent",
        message: "SMTP envelope failed runtime schema validation.",
        retryable: false,
        safeDetails: {
          field: boundary.error.issues[0]?.path ?? "/",
          reason: boundary.error.issues[0]?.code ?? "schema",
        },
      }),
      ok: false,
    };
  }

  const mailFrom =
    boundary.value.mailFrom === null
      ? { ok: true as const, value: null }
      : canonicalizeMailbox(boundary.value.mailFrom);
  if (!mailFrom.ok) {
    return mailFrom;
  }

  const recipients: CanonicalSmtpRecipient[] = [];
  const comparisonKeys = new Set<string>();
  for (const recipient of boundary.value.rcptTo) {
    const canonical = canonicalizeRecipient(recipient);
    if (!canonical.ok) {
      return canonical;
    }
    if (comparisonKeys.has(canonical.value.mailbox.comparisonKey)) {
      return {
        error: validationFailure("rcptTo", "duplicate_mailbox"),
        ok: false,
      };
    }
    comparisonKeys.add(canonical.value.mailbox.comparisonKey);
    recipients.push(canonical.value);
  }

  const requiresSmtpUtf8 =
    (mailFrom.value?.requiresSmtpUtf8 ?? false) ||
    recipients.some((recipient) => recipient.mailbox.requiresSmtpUtf8);
  if (requiresSmtpUtf8 && !boundary.value.smtpUtf8) {
    return { error: validationFailure("smtpUtf8", "required_for_utf8_local_part"), ok: false };
  }

  const wireRecipients = Object.freeze(
    recipients.map((recipient) =>
      Object.freeze({
        address: recipient.mailbox.address,
        ...(recipient.dsn === undefined ? {} : { dsn: recipient.dsn }),
      }),
    ),
  );
  const wire: SmtpEnvelopeV1 = Object.freeze({
    ...(boundary.value.body === undefined ? {} : { body: boundary.value.body }),
    ...(boundary.value.dsn === undefined ? {} : { dsn: boundary.value.dsn }),
    mailFrom: mailFrom.value?.address ?? null,
    rcptTo: wireRecipients,
    ...(boundary.value.requireTls === undefined ? {} : { requireTls: boundary.value.requireTls }),
    schemaVersion: "v1" as const,
    smtpUtf8: boundary.value.smtpUtf8,
  });

  return {
    ok: true,
    value: Object.freeze({
      mailFrom: mailFrom.value,
      recipients: Object.freeze(recipients),
      wire,
    }),
  };
};
