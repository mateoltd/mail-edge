# Mail Edge

Mail Edge is a provider-neutral foundation for durable mail ingestion and delivery. The repository
contains versioned contracts, invariant-preserving core reducers and ports, an
infrastructure-neutral SDK facade, a public provider SPI, and an executable provider conformance
kit. Concrete providers, runtime infrastructure, and the reference service are developed as separate
dependency layers.

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
