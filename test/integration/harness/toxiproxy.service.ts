import { GenericContainer, TestContainers, Wait, type StartedTestContainer } from "testcontainers";

const controlPort = 8474;
const firstProxyPort = 8666;
const lastProxyPort = 8675;

type ToxiproxyStream = "downstream" | "upstream";
type ToxiproxyToxicType =
  "bandwidth" | "latency" | "limit_data" | "reset_peer" | "slow_close" | "timeout";

export interface ToxiproxyToxic {
  readonly attributes: Readonly<Record<string, number>>;
  readonly name: string;
  readonly stream: ToxiproxyStream;
  readonly toxicity?: number;
  readonly type: ToxiproxyToxicType;
}

export interface ToxiproxyEndpoint {
  readonly host: string;
  readonly port: number;
}

const responseFailure = async (response: Response, operation: string): Promise<never> => {
  const body = (await response.text()).slice(0, 1024);
  throw new Error(`Toxiproxy ${operation} failed with status ${String(response.status)}: ${body}`);
};

/** Owns one pinned Toxiproxy container and its bounded proxy-port allocation. */
export class ToxiproxyService {
  readonly #hostPorts: readonly number[];
  #container: StartedTestContainer | undefined;
  #nextPort = firstProxyPort;

  constructor(hostPorts: readonly number[] = []) {
    this.#hostPorts = Object.freeze([...hostPorts]);
  }

  async start(): Promise<void> {
    if (this.#container !== undefined) throw new Error("Toxiproxy is already started.");
    if (this.#hostPorts.length > 0) await TestContainers.exposeHostPorts(...this.#hostPorts);
    const proxyPorts = Array.from(
      { length: lastProxyPort - firstProxyPort + 1 },
      (_value, index) => firstProxyPort + index,
    );
    this.#container = await new GenericContainer("ghcr.io/shopify/toxiproxy:2.12.0")
      .withExposedPorts(controlPort, ...proxyPorts)
      .withWaitStrategy(Wait.forHttp("/version", controlPort))
      .withStartupTimeout(60_000)
      .start();
  }

  async close(): Promise<void> {
    const container = this.#container;
    this.#container = undefined;
    if (container !== undefined) await container.stop();
  }

  async createProxy(name: string, upstream: string): Promise<ToxiproxyEndpoint> {
    const container = this.#requiredContainer();
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(name)) {
      throw new TypeError("Toxiproxy proxy names must be bounded stable tokens.");
    }
    if (this.#nextPort > lastProxyPort) throw new RangeError("Toxiproxy proxy ports exhausted.");
    const internalPort = this.#nextPort;
    this.#nextPort += 1;
    const response = await this.#request("/proxies", {
      body: JSON.stringify({
        enabled: true,
        listen: `0.0.0.0:${String(internalPort)}`,
        name,
        upstream,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) return responseFailure(response, "proxy creation");
    await response.body?.cancel();
    return Object.freeze({
      host: container.getHost(),
      port: container.getMappedPort(internalPort),
    });
  }

  async addToxic(proxyName: string, toxic: ToxiproxyToxic): Promise<void> {
    const response = await this.#request(`/proxies/${encodeURIComponent(proxyName)}/toxics`, {
      body: JSON.stringify({
        attributes: toxic.attributes,
        name: toxic.name,
        stream: toxic.stream,
        toxicity: toxic.toxicity ?? 1,
        type: toxic.type,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) await responseFailure(response, "toxic creation");
    await response.body?.cancel();
  }

  async removeToxic(proxyName: string, toxicName: string): Promise<void> {
    const response = await this.#request(
      `/proxies/${encodeURIComponent(proxyName)}/toxics/${encodeURIComponent(toxicName)}`,
      { method: "DELETE" },
    );
    if (!response.ok) await responseFailure(response, "toxic removal");
    await response.body?.cancel();
  }

  async setEnabled(proxyName: string, enabled: boolean): Promise<void> {
    const response = await this.#request(`/proxies/${encodeURIComponent(proxyName)}`, {
      body: JSON.stringify({ enabled }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) await responseFailure(response, "proxy update");
    await response.body?.cancel();
  }

  async reset(): Promise<void> {
    const response = await this.#request("/reset", { method: "POST" });
    if (!response.ok) await responseFailure(response, "reset");
    await response.body?.cancel();
  }

  #requiredContainer(): StartedTestContainer {
    if (this.#container === undefined) throw new Error("Toxiproxy is not started.");
    return this.#container;
  }

  #request(path: string, init: RequestInit): Promise<Response> {
    const container = this.#requiredContainer();
    return fetch(
      new URL(
        path,
        `http://${container.getHost()}:${String(container.getMappedPort(controlPort))}`,
      ),
      { ...init, signal: AbortSignal.timeout(5_000) },
    );
  }
}
