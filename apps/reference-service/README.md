# Reference service

`@mail-edge/reference-service` is the deployable HTTP owner and sole concrete Node composition root
for Mail Edge. Its public host contracts stay provider-neutral; the shipped production composition
explicitly registers Mailgun and wires the SDK, durable runtime, PostgreSQL 17, encrypted versioned
S3 or MinIO storage, pg-boss wakeups, KMS, secret references, signed host callbacks, workers,
maintenance, lifecycle, and readiness.

`MAIL_EDGE_REFERENCE_CONFIG` must name an absolute, bounded JSON config file. The deployable example
loads `/srv/reference-service/dist/production-composition.js`; custom absolute ESM composition
modules remain supported. Startup fails closed if configuration, migrations, keys, workflow
services, exact adapter registrations, secrets, PostgreSQL, bucket versioning, pg-boss, host
integration, KMS, or required telemetry is missing or invalid. The process never installs a
fallback.

Build and run the focused checks:

```sh
corepack pnpm --filter @mail-edge/reference-service... build
corepack pnpm --filter @mail-edge/reference-service test
corepack pnpm reference-service:e2e
corepack pnpm reference-service:container
```

For local infrastructure, copy `local/config.example.json` to the ignored `local/config.json`,
create the ignored `local/secrets` directory, and replace every example identity, endpoint, key
reference, binding snapshot, capability digest, and secret file. Then run:

```sh
docker compose -f apps/reference-service/compose.yaml up -d postgres minio minio-init
docker compose -f apps/reference-service/compose.yaml --profile runtime up --build reference-service
```

The compose stack pins PostgreSQL 17.6 and MinIO, enables bucket versioning, and runs the real
production graph. The container qualification also proves non-root/read-only startup,
`SIGKILL`/restart recovery, and bounded graceful shutdown. See the
[operator runbook](../../docs/operations/reference-service.md),
[OpenAPI description](openapi/reference-service.v1.yaml), and
[composition ADR](../../docs/adr/0001-reference-service-composition.md).
