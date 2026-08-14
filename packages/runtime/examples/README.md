# Operational composition example

`maintenance-composition.mjs` composes the provider-neutral recovery, reconciliation, retention,
orphan, promotion, stage-cleanup, and wakeup-repair workers. Pass a real
`PostgresWakeupRepairRepository` as `wakeupRepairSource`; the example deliberately accepts
already-constructed PostgreSQL, S3, provider-registry, pg-boss, encryption, and observability
adapters so secrets and tenant authority never become ambient runtime state.

Use `startUntilCanceled` only with a process-owner signal. Request-scoped cancellation belongs on
the individual immutable `Result` API call, not on runtime lifecycle ownership.
