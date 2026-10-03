import { pathToFileURL } from "node:url";

import type { MailEdgeError, Result } from "@mail-edge/contracts";

import { asHostError, hostError } from "./errors.js";
import type {
  ReferenceServiceComposition,
  ReferenceServiceCompositionContext,
  ReferenceServiceCompositionModule,
} from "./ports.js";

const isCompositionModule = (value: unknown): value is ReferenceServiceCompositionModule =>
  typeof value === "object" &&
  value !== null &&
  "createReferenceServiceComposition" in value &&
  typeof value.createReferenceServiceComposition === "function";

const isComposition = (value: unknown): value is ReferenceServiceComposition =>
  typeof value === "object" &&
  value !== null &&
  "envelopeKeys" in value &&
  typeof value.envelopeKeys === "object" &&
  value.envelopeKeys !== null &&
  "generate" in value.envelopeKeys &&
  typeof value.envelopeKeys.generate === "function" &&
  "unwrap" in value.envelopeKeys &&
  typeof value.envelopeKeys.unwrap === "function" &&
  "sensitiveValueCipher" in value &&
  typeof value.sensitiveValueCipher === "object" &&
  value.sensitiveValueCipher !== null &&
  "protect" in value.sensitiveValueCipher &&
  typeof value.sensitiveValueCipher.protect === "function" &&
  "unprotect" in value.sensitiveValueCipher &&
  typeof value.sensitiveValueCipher.unprotect === "function" &&
  "createRuntime" in value &&
  typeof value.createRuntime === "function" &&
  "close" in value &&
  typeof value.close === "function";

export const loadComposition = async (
  path: string,
  context: ReferenceServiceCompositionContext,
  signal: AbortSignal,
): Promise<Result<ReferenceServiceComposition, MailEdgeError>> => {
  try {
    signal.throwIfAborted();
    const imported: unknown = await import(pathToFileURL(path).href);
    if (!isCompositionModule(imported)) {
      return { error: hostError("HOST_UNAVAILABLE", "composition_module_invalid"), ok: false };
    }
    const result: unknown = await imported.createReferenceServiceComposition(context, signal);
    if (
      typeof result !== "object" ||
      result === null ||
      !("ok" in result) ||
      typeof result.ok !== "boolean"
    ) {
      return { error: hostError("HOST_UNAVAILABLE", "composition_result_invalid"), ok: false };
    }
    if (!result.ok) {
      if (!("error" in result)) {
        return { error: hostError("HOST_UNAVAILABLE", "composition_error_invalid"), ok: false };
      }
      return result.error instanceof Error
        ? { error: asHostError(result.error, "composition_failed"), ok: false }
        : { error: hostError("HOST_UNAVAILABLE", "composition_error_invalid"), ok: false };
    }
    if (!("value" in result)) {
      return { error: hostError("HOST_UNAVAILABLE", "composition_result_invalid"), ok: false };
    }
    if (!isComposition(result.value)) {
      return { error: hostError("HOST_UNAVAILABLE", "composition_invalid"), ok: false };
    }
    return { ok: true, value: result.value };
  } catch (cause) {
    return { error: asHostError(cause, "composition_load_failed"), ok: false };
  }
};
