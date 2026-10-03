export type { HeaderPatchApplication, HeaderPatchSink } from "./header-patch.service.js";
export { StreamingHeaderPatchApplier } from "./header-patch.service.js";
export type {
  LegacyLineEndingMode,
  PhysicalHeaderField,
  TopLevelHeaderIndex,
  TopLevelHeaderScanLimits,
} from "./header-scanner.js";
export { DEFAULT_TOP_LEVEL_HEADER_LIMITS, scanTopLevelHeaders } from "./header-scanner.js";
export type {
  MimeStructureInput,
  MimeStructureLimits,
  MimeStructurePart,
  MimeStructureSummary,
} from "./mailsplit-inspector.service.js";
export {
  DEFAULT_MIME_STRUCTURE_LIMITS,
  MailsplitStructuralInspector,
} from "./mailsplit-inspector.service.js";
export type {
  SemanticAddress,
  SemanticAttachmentView,
  SemanticHeaderView,
  SemanticInspectionLimits,
  SemanticMessageView,
} from "./semantic-inspector.service.js";
export {
  BoundedPostalMimeInspector,
  DEFAULT_SEMANTIC_INSPECTION_LIMITS,
} from "./semantic-inspector.service.js";
export type {
  MimeCpuClock,
  MimeInspectionInstrumentationEvent,
  MimeInspectionInstrumentationOptions,
  MimeInspectionInstrumentationSink,
} from "./inspection-budget.js";
