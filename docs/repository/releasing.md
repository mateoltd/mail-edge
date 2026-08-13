# Release operations

Publishable package changes use Changesets. Version changes and generated API reports land before a
release tag is created. Tags are immutable and must point to a commit that passed the protected
default-branch checks.

On a published GitHub release, the release workflow:

1. installs from the frozen lockfile with the exact toolchain;
2. runs the complete repository gate;
3. publishes eligible packages through npm trusted publishing with provenance;
4. creates a deterministic source archive and CycloneDX SBOM;
5. creates GitHub provenance and SBOM attestations;
6. signs the archive and SBOM with keyless cosign; and
7. uploads the archive, SBOM, checksums, and Sigstore bundles to the release.

Release environments must require maintainer approval. No long-lived npm or Sigstore credential
belongs in GitHub secrets. A failed gate or missing evidence stops the release; maintainers create a
new version rather than moving a tag.
