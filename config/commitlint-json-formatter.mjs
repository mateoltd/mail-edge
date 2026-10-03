// Preserve structured rule identities without parsing human-readable diagnostics.
export default function formatCommitlintReport(report) {
  return JSON.stringify(report.results);
}
