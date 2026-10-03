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

`config/dependency-license-policy.json` is the shared local and hosted license policy. Its fifteen
artifact reviews identify exact names, versions, full license expressions and npm integrity hashes:
Bowser `2.14.1`, ten `@img/sharp-libvips-*` `1.3.3` packages and four Windows/Wasm Sharp `0.35.4`
packages. Combined expressions retain AND semantics. There is no general LGPL or MITNFA allowance.
Local checks cover installed development and optional dependencies plus all reviewed lockfile
platform variants. Changing a reviewed version, expression or artifact integrity requires review.

Dependency Review's package exemption currently ignores versions, so this repository does not use
it. The action scans licenses and vulnerabilities with the existing severity and scope settings.
`scripts/check-dependency-review.mjs` then accepts only the exact reviewed license findings. Missing
outputs, unexplained action failures, unresolved licenses, other forbidden licenses and blocking
vulnerabilities fail the job. An action failure caused solely by approved licenses is visible in its
step log and accepted explicitly by the next step.

Bowser's manifest says MIT, but its actual license includes the MITNFA condition. The unmodified
copyright and complete license are retained in `notices/bowser-2.14.1-LICENSE.txt`, the S3 package
and the reference-service image. Its no-false-attribution requirement applies if redistribution
substantially alters functionality outside documented configuration. Mail Edge does not modify
Bowser. `pnpm pack:check` verifies the packed notice and the installed consumer dependency licenses;
the production Docker build checks the deployed dependency tree and Bowser's actual license bytes.

Sharp/libvips belongs to the Miniflare development toolchain. Package reviews authorize its use as
development tooling, not distribution of undocumented binary artifacts. SDK tarballs must not bundle
node_modules; the production distribution check rejects Sharp/libvips. A development image, cache,
node_modules archive or other binary-bearing artifact requires its own evidence before distribution:
applicable component notices, LGPL/GPL license copies, corresponding library source for the exact
binary, and a supported library replacement or recombination/relinking mechanism under LGPL sections
4–5. An upstream homepage alone does not satisfy these obligations. Source-only repository archives
contain no Sharp/libvips binaries. Build stages and private development installs are not published
by this workflow.

Knip's explicit `@commitlint/cli` tooling entry accounts for the CLI invoked through `spawnSync` in
`scripts/check-commitlint.mjs`. It does not relax the commit-message or DCO gates.

Generated evidence must not contain secrets, credentials, private vulnerability reports, production
identifiers, or mail content.
