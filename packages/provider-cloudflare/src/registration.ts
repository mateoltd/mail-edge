import type { Clock, ProviderAdapterRegistration, SecretResolver } from "@mail-edge/provider";

import { CloudflareSmallRequestAuthenticationService } from "./authentication.service.js";
import { cloudflareProviderDescriptor, cloudflareProviderIdentity } from "./capabilities.js";
import {
  CloudflareControlPlaneAdapter,
  type CloudflareControlPlaneConfigV1,
} from "./cloudflare-control-plane.adapter.js";
import {
  CloudflareFeedbackAdapter,
  type CloudflareFeedbackAdapterConfigV1,
} from "./cloudflare-feedback.adapter.js";
import {
  CloudflareInboundAdapter,
  type CloudflareInboundAdapterConfigV1,
  type CloudflareInboundBindingResolver,
} from "./cloudflare-inbound.adapter.js";
import {
  CloudflareOutboundAdapter,
  type CloudflareOutboundAdapterConfigV1,
} from "./cloudflare-outbound.adapter.js";
import {
  CLOUDFLARE_WORKER_FEEDBACK_AUDIENCE,
  CLOUDFLARE_WORKER_INGRESS_AUDIENCE,
} from "./constants.js";
import { CloudflareAdapterLifecycle } from "./lifecycle.service.js";
import type { CloudflareRestClient } from "./rest-client.service.js";

/** Complete immutable configuration for one Cloudflare provider mode. @public */
export interface CloudflareProviderRegistrationConfigV1 {
  readonly schemaVersion: "v1";
  readonly inbound: CloudflareInboundAdapterConfigV1;
  readonly outbound: CloudflareOutboundAdapterConfigV1;
  readonly feedback: CloudflareFeedbackAdapterConfigV1;
  readonly controlPlane: CloudflareControlPlaneConfigV1;
}

/** Constructor-injected runtime ports for one Cloudflare registration. @public */
export interface CloudflareProviderRegistrationDependencies {
  readonly bindings: CloudflareInboundBindingResolver;
  readonly clock: Clock;
  readonly restClient: CloudflareRestClient;
  readonly secrets: SecretResolver;
}

/** Builds the concrete experimental registration without network I/O or provider mutation. @public */
export const createCloudflareProviderRegistration = (
  config: CloudflareProviderRegistrationConfigV1,
  dependencies: CloudflareProviderRegistrationDependencies,
): ProviderAdapterRegistration => {
  if (
    config.inbound.keyRing.audience !== CLOUDFLARE_WORKER_INGRESS_AUDIENCE ||
    config.feedback.keyRing.audience !== CLOUDFLARE_WORKER_FEEDBACK_AUDIENCE
  ) {
    throw new TypeError("Cloudflare provider registration audiences are invalid.");
  }
  const lifecycle = new CloudflareAdapterLifecycle();
  const feedbackAuthentication = new CloudflareSmallRequestAuthenticationService(
    config.feedback.keyRing,
    dependencies.secrets,
    dependencies.clock,
  );
  const inbound = new CloudflareInboundAdapter(config.inbound, dependencies.bindings, lifecycle);
  const outbound = new CloudflareOutboundAdapter(
    config.outbound,
    dependencies.restClient,
    lifecycle,
  );
  const feedback = new CloudflareFeedbackAdapter(
    config.feedback,
    feedbackAuthentication,
    lifecycle,
  );
  const controlPlane = new CloudflareControlPlaneAdapter(
    config.controlPlane,
    dependencies.restClient,
    dependencies.clock,
    lifecycle,
  );
  return Object.freeze({
    controlPlane,
    descriptor: cloudflareProviderDescriptor,
    feedback,
    identity: cloudflareProviderIdentity,
    inbound,
    lifecycle,
    outbound,
  });
};
