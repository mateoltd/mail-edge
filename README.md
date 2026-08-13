# Mail Edge

Mail Edge is a provider-neutral foundation for durable mail ingestion and delivery. The repository
currently contains only its monorepo, quality, governance, and supply-chain foundation. It does not
yet publish a usable SDK, service, provider integration, or mail-processing implementation.

## Development

The toolchain is pinned to Node.js 24.19.0 and pnpm 11.21.0. Enable Corepack, install the locked
dependencies, and run the complete local gate:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm clean-room:check` repeats installation and verification from a Git archive. It requires a
clean, committed worktree.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements, [SECURITY.md](SECURITY.md) for
private vulnerability reporting, and [docs/adr](docs/adr) for architecture decision records.

## License

Licensed under the [Apache License 2.0](LICENSE).
