import { createResendProviderRegistration } from "@mail-edge/provider-resend";

/**
 * Composition roots provide real secret, stage, workflow, replay, and clock implementations.
 * This example intentionally performs no I/O and contains no credential values.
 */
export const registerResend = (registry, config, dependencies) => {
  const created = createResendProviderRegistration(config, dependencies);
  if (!created.ok) throw created.error;
  const registered = registry.register(created.value);
  if (!registered.ok) throw registered.error;
  return created.value;
};
