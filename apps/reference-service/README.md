# Reference service

`@mail-edge/reference-service` is the provider-neutral, deployable HTTP owner for Mail Edge. It
composes the SDK, PostgreSQL 17 runtime, encrypted versioned S3 storage, pg-boss wakeups, and
provider adapters without importing any concrete provider package.

The executable has no default composition. `MAIL_EDGE_REFERENCE_CONFIG` must name an absolute,
bounded JSON config file, and that config must name an absolute ESM composition module. Startup
fails if the module, keys, workflow port, adapter registrations, secrets, database, versioned
bucket, queue, or telemetry exporter is unavailable. The process never installs a fallback.

Build and run the focused checks:

```sh
corepack pnpm --filter @mail-edge/reference-service... build
corepack pnpm --filter @mail-edge/reference-service test
corepack pnpm reference-service:e2e
corepack pnpm reference-service:container
```

For local infrastructure, copy `local/config.example.json` to the ignored `local/config.json`,
create the ignored `local/secrets` directory, and supply a real composition at
`local/composition.mjs`. Then run:

```sh
docker compose -f apps/reference-service/compose.yaml up -d postgres minio minio-init
docker compose -f apps/reference-service/compose.yaml --profile runtime up --build reference-service
```

The compose stack pins PostgreSQL 17.6 and MinIO, enables bucket versioning, and deliberately does
not ship a provider or workflow substitute. See the
[operator runbook](../../docs/operations/reference-service.md),
[OpenAPI description](openapi/reference-service.v1.yaml), and
[composition ADR](../../docs/adr/0001-reference-service-composition.md).
