import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type {
  MailEdgeError,
  ProviderInstanceId,
  Result,
  RouteBindingSnapshotV1,
} from "@mail-edge/contracts";
import { hostError } from "./errors.js";

const secretReference = /^secret:\/\/([a-z][a-z0-9_-]{0,127})$/u;

interface HttpFetchPort {
  fetch(request: Request): Promise<Response>;
}

interface InboundBindingResolverPort {
  resolve(
    input: { readonly bindingHint: string; readonly providerInstanceId: ProviderInstanceId },
    signal: AbortSignal,
  ): Promise<Result<RouteBindingSnapshotV1, MailEdgeError>>;
}

interface WebhookSecretSinkPort {
  store(
    destination: string,
    secret: Uint8Array,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
}

export class NativeCloudflareFetch implements HttpFetchPort {
  fetch(request: Request): Promise<Response> {
    return globalThis.fetch(request);
  }
}

export class ConfiguredCloudflareBindingResolver implements InboundBindingResolverPort {
  readonly #binding: RouteBindingSnapshotV1;
  readonly #bindingHint: string;

  constructor(bindingHint: string, binding: RouteBindingSnapshotV1) {
    this.#bindingHint = bindingHint;
    this.#binding = binding;
  }

  resolve(
    input: { readonly bindingHint: string; readonly providerInstanceId: ProviderInstanceId },
    signal: AbortSignal,
  ): Promise<Result<RouteBindingSnapshotV1, MailEdgeError>> {
    if (signal.aborted) {
      return Promise.resolve({
        error: hostError("HOST_UNAVAILABLE", "cloudflare_binding_resolution_canceled"),
        ok: false,
      });
    }
    return Promise.resolve(
      input.bindingHint === this.#bindingHint &&
        input.providerInstanceId === this.#binding.providerInstanceId
        ? { ok: true, value: this.#binding }
        : {
            error: hostError("BINDING_UNAVAILABLE", "cloudflare_binding_hint_unknown", {
              retryable: false,
            }),
            ok: false,
          },
    );
  }
}

/** Exclusive, no-follow destination for one-time webhook secrets returned by Resend. */
export class DirectoryWebhookSecretSink implements WebhookSecretSinkPort {
  readonly #directory: string;

  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new TypeError("Secret directory must be absolute.");
    this.#directory = directory;
  }

  async store(
    destination: string,
    secret: Uint8Array,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    const name = secretReference.exec(destination)?.[1];
    if (name === undefined || secret.byteLength < 1 || secret.byteLength > 64 * 1024) {
      return {
        error: hostError("VALIDATION_FAILED", "webhook_secret_destination_invalid"),
        ok: false,
      };
    }
    if (signal.aborted) {
      return { error: hostError("HOST_UNAVAILABLE", "webhook_secret_store_canceled"), ok: false };
    }
    const path = resolve(this.#directory, name);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    try {
      handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      await handle.writeFile(secret, { signal });
      await handle.sync();
      await handle.close();
      handle = undefined;
      return { ok: true, value: undefined };
    } catch (cause) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (created) await unlink(path).catch(() => undefined);
      return {
        error: hostError("HOST_UNAVAILABLE", "webhook_secret_store_failed", {
          cause,
          retryable: false,
        }),
        ok: false,
      };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
