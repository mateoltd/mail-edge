import {
  DurableLeaseRecoveryWorker,
  DurableMaintenanceCoordinator,
  DurableReconciliationWorker,
  DurableWakeupRepairTask,
  NamedTenantMaintenanceTask,
} from "@mail-edge/runtime";

/**
 * Compose the bounded tenant-maintenance side of a production runtime from real adapters.
 * The caller retains construction of secrets, PostgreSQL, S3, providers, pg-boss, and metrics.
 */
export function composeTenantMaintenance({
  clock,
  config,
  limiter,
  observability,
  orphanReaper,
  promotionRepair,
  providers,
  queue,
  retentionWorker,
  stageCleanup,
  store,
  unitOfWork,
  wakeupRepairSource,
}) {
  const recovery = new DurableLeaseRecoveryWorker({
    clock,
    config,
    limiter,
    observability,
    store,
    transactions: unitOfWork,
    wakeups: queue,
  });
  const reconciliation = new DurableReconciliationWorker({
    clock,
    config,
    limiter,
    observability,
    providers,
    store,
    transactions: unitOfWork,
  });
  const wakeupRepair = new DurableWakeupRepairTask({
    clock,
    limit: config.recoveryBatchSize,
    queue,
    source: wakeupRepairSource,
  });

  return new DurableMaintenanceCoordinator({
    config,
    observability,
    schedule: { intervalMilliseconds: 30_000, tenantBatchSize: 100 },
    tasks: [
      new NamedTenantMaintenanceTask("lease_recovery", recovery),
      new NamedTenantMaintenanceTask("reconciliation", reconciliation),
      new NamedTenantMaintenanceTask("wakeup_repair", wakeupRepair),
      new NamedTenantMaintenanceTask("retention", retentionWorker),
      new NamedTenantMaintenanceTask("orphan_reaping", orphanReaper),
      new NamedTenantMaintenanceTask("promotion_repair", promotionRepair),
      new NamedTenantMaintenanceTask("stage_cleanup", stageCleanup),
    ],
    tenants: store,
  });
}

/** Start once, await the owner signal without polling, then complete graceful close. */
export async function startUntilCanceled(host, ownerSignal, stopDeadlineMilliseconds = 30_000) {
  const started = await host.start(ownerSignal);
  if (!started.ok) throw started.error;

  if (!ownerSignal.aborted) {
    await new Promise((resolve) => ownerSignal.addEventListener("abort", resolve, { once: true }));
  }
  const closed = await host.close(AbortSignal.timeout(stopDeadlineMilliseconds));
  if (!closed.ok) throw closed.error;
}
