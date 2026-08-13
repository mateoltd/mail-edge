# Contributing

Thank you for improving Mail Edge. Contributions should stay focused, include observable
verification, and avoid introducing unsupported product surfaces.

## Prerequisites

- Node.js 24.19.0
- Corepack
- pnpm 11.21.0

Install and verify with the exact checked-in toolchain:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Use Conventional Commit messages. Add a Changeset when a publishable package's behavior or public
API changes. API Extractor reports are reviewed public API artifacts and must be updated through the
configured command, never edited by hand.

## Developer Certificate of Origin

Contributions use the [Developer Certificate of Origin 1.1](https://developercertificate.org/). Sign
every commit with Git's `-s` option:

```sh
git commit -s -m "type: concise description"
```

The sign-off certifies that you have the right to submit the contribution under the repository's
Apache-2.0 license. Pull requests fail when an author's commit lacks a matching `Signed-off-by`
trailer.

## Pull requests

Before requesting review:

1. Rebase on the current `main` branch without rewriting other contributors' work.
2. Run `pnpm verify` and the affected observable tests.
3. Run `pnpm clean-room:check` for package, build, or repository-tooling changes.
4. Explain compatibility and security effects. Report vulnerabilities privately according to
   [SECURITY.md](SECURITY.md).
5. Keep generated files deterministic and include them in the same change.

All contributions are reviewed under [GOVERNANCE.md](GOVERNANCE.md).
