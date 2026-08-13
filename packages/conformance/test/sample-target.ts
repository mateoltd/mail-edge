import { createFixtureHttpRequest } from "../src/fixtures.js";
import type { ProviderConformanceTarget } from "../src/conformance-kit.service.js";

import {
  prepareSampleDispatch,
  prepareSampleReconciliation,
  sampleControlStateDigest,
  sampleFeedbackPayload,
  sampleRegistration,
} from "./third-party-sample.adapter.js";

export const createSampleTarget = (): ProviderConformanceTarget => ({
  driver: {
    controlStateDigest: sampleControlStateDigest,
    createFeedbackRequest: (scenario, fixtures) => {
      const bytes = sampleFeedbackPayload(scenario, fixtures.feedback);
      return Promise.resolve(
        createFixtureHttpRequest(bytes, fixtures.observedAt, {
          contentType: "application/json",
          path: "/sample-feedback",
        }),
      );
    },
    createInboundRequest: (fixtures) =>
      Promise.resolve({
        request: createFixtureHttpRequest(fixtures.rawBytes, fixtures.observedAt, {
          chunkBytes: 7,
          contentType: "message/rfc822",
          path: "/sample-inbound",
        }),
      }),
    prepareDispatchScenario: (scenario) => {
      prepareSampleDispatch(scenario);
    },
    prepareReconciliationScenario: (scenario) => {
      prepareSampleReconciliation(scenario);
    },
  },
  environment: Object.freeze({ accountTier: "fixture", transport: "in_memory" }),
  region: "test-region",
  registration: sampleRegistration,
});
