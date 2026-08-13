const packageUnit = (id, name, root, dependencies) =>
  Object.freeze({
    dependencies: Object.freeze(dependencies),
    id,
    kind: "package",
    name,
    publishable: true,
    root,
  });

const applicationUnit = (id, name, root, dependencies) =>
  Object.freeze({
    dependencies: Object.freeze(dependencies),
    id,
    kind: "application",
    name,
    publishable: false,
    root,
  });

export const workspaceUnits = Object.freeze([
  packageUnit("contracts", "@mail-edge/contracts", "packages/contracts", []),
  packageUnit("core", "@mail-edge/core", "packages/core", ["contracts"]),
  packageUnit("provider", "@mail-edge/provider", "packages/provider", ["contracts", "core"]),
  packageUnit("mime", "@mail-edge/mime", "packages/mime", ["contracts"]),
  packageUnit("postgres", "@mail-edge/postgres", "packages/postgres", ["contracts", "core"]),
  packageUnit("blob-s3", "@mail-edge/blob-s3", "packages/blob-s3", ["core"]),
  packageUnit("queue-pg-boss", "@mail-edge/queue-pg-boss", "packages/queue-pg-boss", ["core"]),
  packageUnit("sdk", "@mail-edge/sdk", "packages/sdk", ["contracts", "core"]),
  packageUnit("http-client", "@mail-edge/http-client", "packages/http-client", ["contracts"]),
  packageUnit("smtp-bridge", "@mail-edge/smtp-bridge", "packages/smtp-bridge", [
    "contracts",
    "core",
  ]),
  packageUnit("observability", "@mail-edge/observability", "packages/observability", []),
  packageUnit("conformance", "@mail-edge/conformance", "packages/conformance", ["provider"]),
  packageUnit("provider-mailgun", "@mail-edge/provider-mailgun", "packages/provider-mailgun", [
    "provider",
  ]),
  packageUnit("provider-resend", "@mail-edge/provider-resend", "packages/provider-resend", [
    "provider",
  ]),
  packageUnit(
    "provider-cloudflare",
    "@mail-edge/provider-cloudflare",
    "packages/provider-cloudflare",
    ["provider"],
  ),
  applicationUnit("reference-service", "@mail-edge/reference-service", "apps/reference-service", [
    "blob-s3",
    "mime",
    "observability",
    "postgres",
    "provider-cloudflare",
    "provider-mailgun",
    "provider-resend",
    "queue-pg-boss",
    "sdk",
    "smtp-bridge",
  ]),
  applicationUnit(
    "cloudflare-ingress-worker",
    "@mail-edge/cloudflare-ingress-worker",
    "apps/cloudflare-ingress-worker",
    ["contracts"],
  ),
]);

export const workspaceUnitById = new Map(workspaceUnits.map((unit) => [unit.id, unit]));
export const workspaceUnitByName = new Map(workspaceUnits.map((unit) => [unit.name, unit]));
