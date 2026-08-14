# Supply-chain policy

The repository treats the lockfile, package manifests, action pins, API reports, SBOMs, provenance,
and signatures as reviewable release inputs.

## Required gates

- GitHub Actions are pinned to full commit SHAs and checked by `pnpm actions:check`; actionlint
  validates workflow syntax from a checksum-pinned binary.
- Installs use the exact Node and pnpm pins with a frozen lockfile. Dependency lifecycle scripts
  fail unless the package is explicitly approved.
- Dependency review blocks newly introduced moderate-or-higher vulnerabilities and unapproved
  licenses on pull requests.
- Scheduled and change-triggered scans run CodeQL, OSV-Scanner, and Gitleaks.
- `pnpm license:check` evaluates the complete installed dependency inventory against the repository
  allowlist. Narrow exceptions identify exact package names, versions, and license expressions so
  dependency drift fails closed.
- `pnpm sbom:check` generates and parses a CycloneDX 1.6 SBOM without installing dependencies
  dynamically.
- Release source archives and SBOMs receive keyless Sigstore bundles and GitHub attestations. npm
  publishing uses trusted publishing with provenance enabled.

Release container images do not exist at the repository-foundation stage. When an image is
introduced, its workflow must attach a CycloneDX SBOM and sign the immutable image digest with
keyless cosign before it can be released.

## Dependency policy

Direct dependencies are exact and lockfile updates are reviewed. New runtime dependencies require a
concrete need, maintained upstream, compatible license, and a security review proportionate to their
privilege and data access. Install scripts remain blocked unless an explicit, narrowly scoped
approval is reviewed in `pnpm-workspace.yaml`.

The current Cloudflare Workers developer toolchain uses the platform-specific `@img/sharp-libvips-*`
version `1.3.1` packages under `LGPL-3.0-or-later` through Miniflare. These packages are
development-only, are not included in published mail-edge packages or the Worker bundle, and have an
exact package-and-version exception in the license check. Updating Miniflare, Wrangler, the Workers
Vitest pool, or libvips requires renewed review.

Generated evidence must not contain secrets, credentials, private vulnerability reports, production
identifiers, or mail content.
