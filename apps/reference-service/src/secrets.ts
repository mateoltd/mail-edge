import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { MailEdgeError, Result } from "@mail-edge/contracts";
import type { SecretResolver } from "@mail-edge/core";

import { hostError } from "./errors.js";

const secretReferenceExpression = /^secret:\/\/([a-z][a-z0-9_-]{0,127})$/u;
const MAXIMUM_SECRET_BYTES = 64 * 1024;

export class DirectorySecretResolver implements SecretResolver {
  readonly #directory: string;

  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new TypeError("Secret directory must be absolute.");
    this.#directory = directory;
  }

  async resolve(
    reference: string,
    signal: AbortSignal,
  ): Promise<Result<Uint8Array, MailEdgeError>> {
    if (signal.aborted) {
      return { error: hostError("HOST_UNAVAILABLE", "secret_resolution_canceled"), ok: false };
    }
    const match = secretReferenceExpression.exec(reference);
    if (match?.[1] === undefined) {
      return { error: hostError("VALIDATION_FAILED", "secret_reference_invalid"), ok: false };
    }
    const path = resolve(this.#directory, match[1]);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size < 1 ||
        metadata.size > MAXIMUM_SECRET_BYTES
      ) {
        return { error: hostError("HOST_UNAVAILABLE", "secret_file_invalid"), ok: false };
      }
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const bytes = await handle.readFile({ signal });
      if (bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_SECRET_BYTES) {
        bytes.fill(0);
        return { error: hostError("HOST_UNAVAILABLE", "secret_file_invalid"), ok: false };
      }
      return { ok: true, value: Uint8Array.from(bytes) };
    } catch (cause) {
      return {
        error: hostError("HOST_UNAVAILABLE", "secret_resolution_failed", {
          cause,
          retryable: true,
        }),
        ok: false,
      };
    } finally {
      await handle?.close();
    }
  }
}

export const resolveSecretText = async (
  resolver: SecretResolver,
  reference: string,
  signal: AbortSignal,
): Promise<Result<string, MailEdgeError>> => {
  const resolved = await resolver.resolve(reference, signal);
  if (!resolved.ok) return resolved;
  try {
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(resolved.value)
      .replace(/\r?\n$/u, "");
    if (text.length < 1 || text.includes("\0")) {
      return { error: hostError("HOST_UNAVAILABLE", "secret_text_invalid"), ok: false };
    }
    return { ok: true, value: text };
  } catch (cause) {
    return {
      error: hostError("HOST_UNAVAILABLE", "secret_text_invalid", { cause, retryable: false }),
      ok: false,
    };
  } finally {
    resolved.value.fill(0);
  }
};
