import type { CloudflareFetch } from "@mail-edge/provider-cloudflare";

/** Qualification-only origin router; the production client still constructs and validates its path. */
export class OriginRemappingFetch implements CloudflareFetch {
  readonly #origin: URL;

  constructor(origin: URL) {
    this.#origin = new URL(origin);
  }

  fetch(request: Request): Promise<Response> {
    const source = new URL(request.url);
    const target = new URL(this.#origin);
    target.pathname = source.pathname;
    target.search = source.search;
    return fetch(new Request(target, request));
  }
}
