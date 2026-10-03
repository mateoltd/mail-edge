# Qualify and activate a registered installation

`qualify` closes the path from [inactive registration](registration.md) to a usable route. It is an
operator command with database/secret-directory access, not a tenant HTTP endpoint. The shipped
composition currently supports Mailgun; the qualification service accepts the provider SPI and does
not change the existing Resend/Cloudflare data planes or provider replacement rules. Never run a
fixture signer or simulator against a production installation.

The command does **not** mutate provider resources or DNS. Plan/apply using the existing
authenticated operator control-plane endpoints first, or use already provisioned exact resources.
Keep the returned plan digest and provider resource IDs. The approved conformance runner must verify
that the plan was applied to those resources; its signature attests that fact. Import independently
repeats authenticated provider discovery (domain, direction-specific DNS status, exact inbound route
expression/actions) and queries the exact domain's ownership TXT record. It will not accept copied
discovery JSON or caller-supplied passing database checks.

## Operator policy and evidence

Create an operator-owned policy JSON outside Git, separate from the submitted evidence. It has these
required fields, rejects additional properties, and must not be writable by evidence producers:

| Field                         | Value                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`               | `v1`                                                                                                                                                                            |
| `deploymentId`                | Stable unique installation token, 1–64 characters                                                                                                                               |
| `environment`                 | `production` or `nonproduction`                                                                                                                                                 |
| `registration`                | Exact registration manifest, including tenant, instance, binding, domain, region, adapter, secret/config references and revision, capability descriptor, audit actor and reason |
| `requirements`                | `RouteRequirementsV1`, with matching direction and explicit region; choose the application's real requirements                                                                  |
| `providerConfigurationDigest` | `sha256CanonicalJson` of the exact selected `production.mailgun[]` configuration object                                                                                         |
| `verificationLifetimeSeconds` | 60–86400; bounds the lifetime of new provider/DNS observations                                                                                                                  |
| `trustedKeys`                 | Array of `{keyId, publicKeyPem, provenance}` with distinct IDs and Ed25519 public keys                                                                                          |

Use separately approved live-runner public keys, not a key supplied by the report. For production,
every trusted key must have `provenance: "credentialed-live"`. Nonproduction can explicitly
authorize `controlled-nonproduction` keys. A production service configuration rejects a
nonproduction policy. Mailgun remains **experimental** and the route must explicitly allow that
maturity. The existing seven-day maximum experimental report lifetime, required capability checks,
mode/version/digest, region, failed-check, future-time and signature checks remain in force.

The runner is a trust boundary: approve its code, exact credentials/resource scope, live probe logs
and signing-key custody before trusting it. A signature by itself cannot prove how a runner obtained
its observations. The command supplies no signing key and does not turn generic fixture reports into
live evidence. Existing `mail-edge-conformance` target modules can produce the signed v1 envelope;
the approved deployment target must populate the signed environment fields below and actually run
its credentialed checks. Historical stress receipts and generic package conformance reports lack
this installation scope and cannot activate a deployment.

Create a qualification draft JSON with:

```json
{
  "schemaVersion": "v1",
  "bindingVersion": 1,
  "expectedVersion": 0,
  "planDigest": "<64 lowercase hex characters from the applied plan>",
  "providerResourceIds": {
    "domain": "<exact owned A-label domain>",
    "routeId": "<actual inbound Mailgun route ID>"
  }
}
```

For outbound, retain its actual applied resource IDs; an inbound `routeId` is not required. The
exact inbound snapshot in service configuration must match the resource IDs, binding/version, domain
and config revision and the immutable `createdAt` returned by registration (or the existing binding
inspection endpoint). The command compares the entire configured inbound snapshot with the durable
snapshot. This prevents qualifying one route while configuring ingress for another.

Build and inspect the draft offline. This reads no secrets and performs no network/database work:

```sh
corepack pnpm --filter @mail-edge/reference-service... build
corepack pnpm --filter @mail-edge/reference-service qualify \
  --policy /absolute/operator-policy.json --manifest /absolute/qualification.json
```

The output contains `scopeDigest` and `dnsChallenge`. Publish the TXT challenge only through your
normal authorized DNS process. It binds the deployment, tenant, provider instance and exact domain.
It is stable across evidence renewals and direction changes. It does not grant access to a different
tenant or installation. Keep existing MX, SPF and DKIM requirements as reported by Mailgun.

Run the approved live conformance target for this exact scope. Its **signed** report environment
must contain:

- `deploymentId`: the policy deployment ID;
- `deploymentScopeDigest`: the printed scope digest;
- `provenance`: the exact provenance authorized for the report's signing key.

The scope digest covers the registration identity, complete descriptor, requirements, provider
configuration digest, binding and optimistic versions, applied plan digest and resource IDs. Add the
resulting `SignedConformanceReportV1` as the draft's `evidence` field. Any change to these inputs
requires a newly scoped report. Do not edit a signed report's environment after signing.

Import and optionally activate:

```sh
corepack pnpm --filter @mail-edge/reference-service qualify \
  --policy /absolute/operator-policy.json --manifest /absolute/qualification.json \
  --config /absolute/reference-service.json --apply --activate
```

Without `--activate`, success leaves the binding `testing`. `--activate` delegates to the existing
`PostgresControlRepository` transition, including the expected-version guard and atomic draining of
the prior active exact route. No new route-selection/authentication bypass exists. The configured
runtime DB role needs SELECT/INSERT/UPDATE on the existing tables; normal RLS and tenant transaction
context apply. No schema or personal-data migration is required.

## Freshness, retries and replacement

Import rechecks the active tenant and exact durable provider/domain/binding ownership before I/O,
then repeats those checks under row locks after I/O. External calls never execute inside a database
transaction. Cancellation, version conflicts, invalid evidence or audit failure leave no partial
qualification. Successful import records all four checks, finite domain verification, the plan and
resources, enables the instance, advances draft to testing and increments the optimistic version.
Audit rows contain digests and status, not credentials or diagnostic bodies.

An exact current retry returns `imported: false`; it does not renew expiry, emit another audit, or
reactivate a drained route. Effective expiry is the earlier of signed report expiry and the bounded
provider/DNS observation lifetime. Expired evidence blocks activation and route selection. Renew a
testing or active route with its current optimistic version and a newly scoped signed report; checks
are replaced transactionally. An active renewal retains state only for the same resources/plan.
Changed resources require a new binding, preventing in-place mutation of pinned delivery snapshots.

Register both initial directions before qualifying either. A new binding/provider can reuse an
existing tenant-owned domain claim; registration preserves that claim and still creates an inert
binding without checks. Each replacement must prove its own installation TXT and resource scope
before activation. Existing in-flight attempts remain pinned; this does not authorize automatic
fallback after uncertain provider acceptance.

## Actionable failures

| Reason                                                                             | Action                                                                                                                |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `qualification_policy` / `qualification_request` / `qualification_report`          | Correct the strict input schema; do not add passing flags or embedded trust policy                                    |
| `qualification_configured_installation` / `qualification_registration_scope`       | Align config and durable tenant/instance/domain/adapter/reference/revision identities                                 |
| `qualification_provider_configuration_digest`                                      | Recompute the digest from reviewed exact configuration and obtain newly scoped evidence                               |
| `qualification_configured_binding_resources` / `qualification_configured_snapshot` | Align the configured inbound snapshot with the applied resource IDs, version and registration `createdAt`             |
| `qualification_evidence_scope`                                                     | Obtain a report from an approved key for this deployment/version/provenance                                           |
| `qualification_evidence_rejected`                                                  | Inspect the returned gate reasons; fix actual capability, signature, mode, region, freshness or failed-check problems |
| `qualification_provider_drift`                                                     | Run authenticated discovery; repair missing/invalid DNS, domain state or exact route configuration                    |
| `qualification_dns_ownership` / `qualification_dns_lookup`                         | Publish/check the displayed TXT through authorized DNS operations and verify resolver reachability                    |
| `qualification_version_or_state`                                                   | Inspect current binding state/version; re-scope evidence, or create a replacement binding                             |
| `qualification_expired_during_verification`                                        | Obtain fresh evidence; expired observations are never committed                                                       |
| `qualification_new_binding_required`                                               | Create a new inert binding for changed resources/plan                                                                 |
| `activation_evidence`                                                              | Requalify current deployment checks/domain; activation remains fail closed                                            |

Section 16.7 sustained resource/stress qualification is separate from these deployment safety gates.
No stress receipt is required by the existing provider activation policy, so none was removed or
bypassed. The disposable tests use explicit `controlled-nonproduction` trust, real PostgreSQL, local
DNS and HTTP protocols; the composed storage/runtime test provisions Mailgun bindings through
registration → qualification → guarded activation. These tests prove boundaries and development
functionality, not live Mailgun delivery, public DNS or off-host recovery.
