import {
  WorkflowWakeupV1Schema,
  validateContract,
  type Result,
  type ValidationError,
  type WorkflowWakeupV1,
} from "@mail-edge/contracts";

/** Validates an opaque queue payload without trusting queue-owned JSON. @public */
export const parseWorkflowWakeup = (value: unknown): Result<WorkflowWakeupV1, ValidationError> =>
  validateContract(WorkflowWakeupV1Schema, value);
