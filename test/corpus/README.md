# Synthetic mail corpus

Every message in `messages/` is synthetic and licensed under Apache-2.0 with this repository. The
manifest records the exact SHA-256 of each byte artifact and the adversarial features it exercises.
No fixture contains real or private mail.

Run `pnpm corpus:check` to verify identities. Depth and part-count bombs are generated
deterministically by `generators.mjs` so the repository does not carry oversized fixtures.
