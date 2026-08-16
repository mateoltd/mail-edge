interface RunbookConfiguration {
  readonly confirmation: "ephemeral-only";
  readonly evidenceDirectory: string;
  readonly sourceRevision: string;
}

interface RunbookConfigurationFailure {
  readonly code: "invalid_confirmation" | "invalid_evidence_directory" | "invalid_revision";
}

type RunbookConfigurationResult =
  | { readonly ok: true; readonly value: RunbookConfiguration }
  | { readonly error: RunbookConfigurationFailure; readonly ok: false };

const revisionExpression = /^[0-9a-f]{40}$/u;

export const parseRunbookConfiguration = (
  input: Readonly<Record<string, string | undefined>>,
): RunbookConfigurationResult => {
  if (input["DRILL_CONFIRM"] !== "ephemeral-only") {
    return { error: { code: "invalid_confirmation" }, ok: false };
  }
  const evidenceDirectory = input["DRILL_EVIDENCE_DIRECTORY"] ?? "temp/production-drills";
  if (
    evidenceDirectory.startsWith("/") ||
    evidenceDirectory.includes("..") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,255}$/u.test(evidenceDirectory)
  ) {
    return { error: { code: "invalid_evidence_directory" }, ok: false };
  }
  const sourceRevision = input["DRILL_SOURCE_REVISION"];
  if (sourceRevision === undefined || !revisionExpression.test(sourceRevision)) {
    return { error: { code: "invalid_revision" }, ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({
      confirmation: "ephemeral-only",
      evidenceDirectory,
      sourceRevision,
    }),
  };
};

export const isLoopbackServiceUrl = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "postgres:" ||
      url.protocol === "postgresql:") &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost")
  );
};
