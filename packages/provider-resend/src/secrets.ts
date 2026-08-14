import type { MailEdgeError, Result, SecretResolver } from "@mail-edge/provider";

import { resendError } from "./errors.js";

/** Resolves one bounded UTF-8 secret and clears the resolver-owned byte copy. @internal */
export const resolveSecretText = async (
  resolver: SecretResolver,
  reference: string,
  signal: AbortSignal,
): Promise<Result<string, MailEdgeError>> => {
  const resolved = await resolver.resolve(reference, signal);
  if (!resolved.ok) return resolved;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(resolved.value);
    if (text.length < 1 || text.length > 4096 || /[\r\n\0]/u.test(text)) {
      return { error: resendError("AUTHENTICATION_FAILED", "secret_shape"), ok: false };
    }
    return { ok: true, value: text };
  } catch (cause) {
    return {
      error: resendError("AUTHENTICATION_FAILED", "secret_encoding", false, cause),
      ok: false,
    };
  } finally {
    resolved.value.fill(0);
  }
};
