# Governance

Mail Edge uses a maintainer-led, review-based governance model.

## Roles

- Contributors propose issues, documentation, code, and reviews under the DCO.
- Reviewers provide sustained, technically sound review in an area of the project.
- Maintainers merge changes, manage releases and security reports, and protect repository integrity.

Maintainer access is granted by existing maintainers after sustained, trustworthy contributions and
can be removed for inactivity, security risk, or breach of project policy. Repository access remains
least privilege.

## Decisions

Routine changes are decided through pull-request review. Material, durable, or hard-to-reverse
architecture decisions require an ADR under `docs/adr`. Maintainers seek technical consensus; when
consensus is not possible, a maintainer records the decision, alternatives, and objections in the
ADR or pull request.

Security response may proceed privately until disclosure is safe. Changes to licensing, governance,
compatibility policy, or the security model require explicit maintainer approval and cannot be
inferred from silence.

## Releases

Protected automation creates release artifacts. Tags are immutable. Published packages and artifacts
must pass repository gates and carry the configured provenance, SBOM, and signature evidence. A
maintainer may stop a release at any time when its evidence is incomplete.
