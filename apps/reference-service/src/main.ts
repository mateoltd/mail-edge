import { ConfigurationError, loadReferenceServiceConfig } from "./config.js";
import { ReferenceServiceHost } from "./host.js";

const safeFailure = (event: string, cause: unknown): void => {
  const code =
    cause instanceof ConfigurationError
      ? cause.code
      : typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          typeof cause.code === "string"
        ? cause.code
        : "UNCLASSIFIED";
  process.stderr.write(
    `${JSON.stringify({ code, event, type: cause instanceof Error ? cause.name : "Unknown" })}\n`,
  );
};

const run = async (): Promise<void> => {
  const configPath = process.env["MAIL_EDGE_REFERENCE_CONFIG"];
  if (configPath === undefined || configPath.length === 0) {
    throw new ConfigurationError(["/environment/MAIL_EDGE_REFERENCE_CONFIG:required"]);
  }
  const processAbort = new AbortController();
  const host: { current?: ReferenceServiceHost } = {};
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (reason: string, failure: boolean): Promise<void> => {
    shutdownPromise ??= (async () => {
      processAbort.abort(new DOMException(reason, "AbortError"));
      const result = await host.current?.close();
      if (failure || result?.ok === false) process.exitCode = 1;
    })();
    return shutdownPromise;
  };
  const signalHandler = (signal: NodeJS.Signals): void => {
    void shutdown(signal, false).catch((cause: unknown) => {
      safeFailure("shutdown.failed", cause);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  process.once("uncaughtException", (cause) => {
    safeFailure("process.uncaught_exception", cause);
    void shutdown("uncaught_exception", true);
  });
  process.once("unhandledRejection", (cause) => {
    safeFailure("process.unhandled_rejection", cause);
    void shutdown("unhandled_rejection", true);
  });

  const config = await loadReferenceServiceConfig(configPath, processAbort.signal);
  const created = await ReferenceServiceHost.create(config, processAbort.signal);
  if (!created.ok) throw created.error;
  host.current = created.value;
  const started = await host.current.start(processAbort.signal);
  if (!started.ok) throw started.error;
  process.stdout.write(
    `${JSON.stringify({ address: host.current.address, event: "reference_service.ready" })}\n`,
  );
};

void run().catch((cause: unknown) => {
  safeFailure("reference_service.start_failed", cause);
  process.exitCode = 1;
});
