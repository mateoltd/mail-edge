-- Mail Edge W2 runtime schema. Forward-only expand migration.

CREATE TABLE mail_edge_schema_epoch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch integer NOT NULL CHECK (epoch > 0),
  minimum_application_epoch integer NOT NULL CHECK (minimum_application_epoch > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO mail_edge_schema_epoch (singleton, epoch, minimum_application_epoch)
VALUES (true, 1, 1);

CREATE FUNCTION mail_edge_current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE TABLE tenants (
  tenant_id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE domain_claims (
  tenant_id uuid NOT NULL,
  domain_a_label text NOT NULL,
  verification_method text NOT NULL CHECK (octet_length(verification_method) BETWEEN 1 AND 64),
  verification_digest bytea NOT NULL CHECK (octet_length(verification_digest) = 32),
  verified_at timestamptz,
  expires_at timestamptz,
  PRIMARY KEY (tenant_id, domain_a_label),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  CHECK (domain_a_label = lower(domain_a_label)),
  CHECK (domain_a_label !~ '[*]'),
  CHECK (octet_length(domain_a_label) BETWEEN 1 AND 253),
  CHECK (expires_at IS NULL OR verified_at IS NULL OR expires_at > verified_at)
);

CREATE TABLE provider_instances (
  provider_instance_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  provider_id text NOT NULL,
  region text CHECK (region IS NULL OR octet_length(region) BETWEEN 1 AND 64),
  secret_ref text NOT NULL CHECK (octet_length(secret_ref) BETWEEN 1 AND 512),
  config_ref text NOT NULL CHECK (octet_length(config_ref) BETWEEN 1 AND 512),
  state text NOT NULL CHECK (state IN ('enabled', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, provider_instance_id),
  UNIQUE (tenant_id, provider_instance_id, provider_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  CHECK (
    provider_id ~ '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$'
    AND octet_length(provider_id) <= 63
  )
);

CREATE TABLE route_bindings (
  binding_id uuid NOT NULL,
  binding_version bigint NOT NULL CHECK (binding_version > 0),
  tenant_id uuid NOT NULL,
  domain_a_label text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  provider_instance_id uuid NOT NULL,
  provider_id text NOT NULL,
  adapter_version text NOT NULL CHECK (octet_length(adapter_version) BETWEEN 1 AND 64),
  secret_ref text NOT NULL CHECK (octet_length(secret_ref) BETWEEN 1 AND 512),
  config_ref text NOT NULL CHECK (octet_length(config_ref) BETWEEN 1 AND 512),
  config_revision text NOT NULL CHECK (octet_length(config_revision) BETWEEN 1 AND 128),
  capability_snapshot jsonb NOT NULL,
  capability_digest bytea NOT NULL CHECK (octet_length(capability_digest) = 32),
  provider_resource_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL CHECK (state IN ('draft', 'testing', 'active', 'draining', 'retired', 'failed')),
  optimistic_version bigint NOT NULL DEFAULT 0 CHECK (optimistic_version >= 0),
  plan_digest bytea CHECK (plan_digest IS NULL OR octet_length(plan_digest) = 32),
  fallback_eligible boolean NOT NULL DEFAULT false,
  qualified_at timestamptz,
  activated_at timestamptz,
  draining_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (binding_id, binding_version),
  UNIQUE (tenant_id, binding_id, binding_version),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, domain_a_label) REFERENCES domain_claims (tenant_id, domain_a_label),
  FOREIGN KEY (tenant_id, provider_instance_id, provider_id)
    REFERENCES provider_instances (tenant_id, provider_instance_id, provider_id),
  CHECK (domain_a_label = lower(domain_a_label) AND domain_a_label !~ '[*]'),
  CHECK (jsonb_typeof(capability_snapshot) = 'object'),
  CHECK (capability_snapshot ->> 'schemaVersion' = 'v1'),
  CHECK (jsonb_typeof(provider_resource_ids) = 'object'),
  CHECK (NOT fallback_eligible OR direction = 'outbound'),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX route_bindings_one_active_exact
  ON route_bindings (tenant_id, domain_a_label, direction)
  WHERE state = 'active';

CREATE INDEX route_bindings_provider_lookup
  ON route_bindings (tenant_id, provider_instance_id, state);

CREATE TABLE route_binding_checks (
  check_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  binding_version bigint NOT NULL,
  check_kind text NOT NULL CHECK (
    check_kind IN ('capability', 'dns', 'control_plane', 'live_conformance', 'drift')
  ),
  outcome text NOT NULL CHECK (outcome IN ('pass', 'fail', 'expired')),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  report_digest bytea NOT NULL CHECK (octet_length(report_digest) = 32),
  evidence_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, check_id),
  UNIQUE (tenant_id, binding_id, binding_version, check_kind, report_digest),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, binding_id, binding_version)
    REFERENCES route_bindings (tenant_id, binding_id, binding_version),
  CHECK (expires_at > evidence_at)
);

CREATE TABLE blob_ingest_stages (
  stage_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('inbound', 'outbound_upload', 'derived')),
  object_key text NOT NULL UNIQUE CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
  object_version text,
  final_object_key text UNIQUE,
  final_object_version text,
  state text NOT NULL CHECK (
    state IN ('reserved', 'uploading', 'uploaded', 'verified', 'promoting', 'promoted', 'abandoned')
  ),
  expected_max_bytes bigint NOT NULL CHECK (expected_max_bytes >= 0),
  observed_bytes bigint CHECK (observed_bytes IS NULL OR observed_bytes >= 0),
  observed_sha256 bytea CHECK (
    observed_sha256 IS NULL OR octet_length(observed_sha256) = 32
  ),
  encryption_key_ref text NOT NULL CHECK (octet_length(encryption_key_ref) BETWEEN 1 AND 512),
  wrapped_dek bytea NOT NULL CHECK (octet_length(wrapped_dek) > 0),
  encryption_metadata jsonb NOT NULL CHECK (jsonb_typeof(encryption_metadata) = 'object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  optimistic_version bigint NOT NULL DEFAULT 0 CHECK (optimistic_version >= 0),
  UNIQUE (tenant_id, stage_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  CHECK (observed_bytes IS NULL OR observed_bytes <= expected_max_bytes),
  CHECK (expires_at > created_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX blob_ingest_stages_expiry
  ON blob_ingest_stages (expires_at, stage_id)
  WHERE state <> 'promoted' AND state <> 'abandoned';

CREATE TABLE raw_blobs (
  blob_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  source_stage_id uuid NOT NULL,
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  media_type text NOT NULL CHECK (media_type = 'message/rfc822'),
  object_key text NOT NULL UNIQUE CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
  object_version text,
  encryption_format_version smallint NOT NULL CHECK (encryption_format_version > 0),
  wrapped_dek bytea NOT NULL CHECK (octet_length(wrapped_dek) > 0),
  kms_key_ref text NOT NULL CHECK (octet_length(kms_key_ref) BETWEEN 1 AND 512),
  encryption_metadata jsonb NOT NULL CHECK (jsonb_typeof(encryption_metadata) = 'object'),
  status text NOT NULL CHECK (status IN ('available', 'purge_pending', 'deleted', 'corrupt')),
  available_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  optimistic_version bigint NOT NULL DEFAULT 0 CHECK (optimistic_version >= 0),
  UNIQUE (tenant_id, blob_id),
  UNIQUE (tenant_id, source_stage_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, source_stage_id)
    REFERENCES blob_ingest_stages (tenant_id, stage_id),
  CHECK (retain_until >= available_at),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE INDEX raw_blobs_orphan_scan
  ON raw_blobs (available_at, retain_until, blob_id)
  WHERE status = 'available';

CREATE TABLE raw_blob_derivations (
  tenant_id uuid NOT NULL,
  derived_blob_id uuid PRIMARY KEY,
  source_blob_id uuid NOT NULL,
  patch_plan jsonb NOT NULL CHECK (jsonb_typeof(patch_plan) = 'object'),
  patch_plan_digest bytea NOT NULL CHECK (octet_length(patch_plan_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, derived_blob_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, derived_blob_id) REFERENCES raw_blobs (tenant_id, blob_id),
  FOREIGN KEY (tenant_id, source_blob_id) REFERENCES raw_blobs (tenant_id, blob_id),
  CHECK (derived_blob_id <> source_blob_id),
  CHECK (patch_plan ->> 'schemaVersion' = 'v1')
);

CREATE TABLE legal_holds (
  legal_hold_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  blob_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_by text NOT NULL CHECK (octet_length(created_by) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_by text,
  released_at timestamptz,
  UNIQUE (tenant_id, legal_hold_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, blob_id) REFERENCES raw_blobs (tenant_id, blob_id),
  CHECK ((released_by IS NULL) = (released_at IS NULL)),
  CHECK (released_at IS NULL OR released_at >= created_at)
);

CREATE UNIQUE INDEX legal_holds_one_open_per_blob
  ON legal_holds (tenant_id, blob_id)
  WHERE released_at IS NULL;

CREATE TABLE blob_deletions (
  deletion_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  blob_id uuid NOT NULL,
  fence bigint NOT NULL CHECK (fence > 0),
  state text NOT NULL CHECK (
    state IN ('claimed', 'object_deleted', 'completed', 'retry_wait', 'failed')
  ),
  scheduled_at timestamptz NOT NULL,
  claimed_until timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, deletion_id),
  UNIQUE (tenant_id, blob_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, blob_id) REFERENCES raw_blobs (tenant_id, blob_id),
  CHECK (updated_at >= created_at)
);

CREATE TABLE inbound_receipts (
  receipt_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  provider_instance_id uuid NOT NULL,
  provider_receipt_key_ciphertext bytea NOT NULL CHECK (octet_length(provider_receipt_key_ciphertext) > 0),
  binding_id uuid NOT NULL,
  binding_version bigint NOT NULL,
  raw_blob_id uuid,
  envelope jsonb,
  verification_digest bytea CHECK (
    verification_digest IS NULL OR octet_length(verification_digest) = 32
  ),
  state text NOT NULL CHECK (
    state IN (
      'received', 'acquiring', 'stored', 'routing', 'delivering', 'retry_wait',
      'delivered', 'quarantined', 'dead_letter', 'purged'
    )
  ),
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  optimistic_version bigint NOT NULL DEFAULT 0 CHECK (optimistic_version >= 0),
  next_action_at timestamptz,
  claimed_until timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, receipt_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, provider_instance_id)
    REFERENCES provider_instances (tenant_id, provider_instance_id),
  FOREIGN KEY (tenant_id, binding_id, binding_version)
    REFERENCES route_bindings (tenant_id, binding_id, binding_version),
  FOREIGN KEY (tenant_id, raw_blob_id) REFERENCES raw_blobs (tenant_id, blob_id),
  CHECK (envelope IS NULL OR (jsonb_typeof(envelope) = 'object' AND envelope ->> 'schemaVersion' = 'v1')),
  CHECK (
    state IN ('received', 'acquiring', 'quarantined')
    OR (raw_blob_id IS NOT NULL AND envelope IS NOT NULL AND verification_digest IS NOT NULL)
  ),
  CHECK (updated_at >= created_at)
);

CREATE INDEX inbound_receipts_due
  ON inbound_receipts (next_action_at, receipt_id)
  WHERE state IN ('received', 'acquiring', 'stored', 'routing', 'delivering', 'retry_wait');

CREATE INDEX inbound_receipts_received_brin ON inbound_receipts USING brin (received_at);

CREATE TABLE inbound_receipt_dedup (
  tenant_id uuid NOT NULL,
  provider_instance_id uuid NOT NULL,
  provider_receipt_key_hash bytea NOT NULL CHECK (octet_length(provider_receipt_key_hash) = 32),
  receipt_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, provider_instance_id, provider_receipt_key_hash),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, provider_instance_id)
    REFERENCES provider_instances (tenant_id, provider_instance_id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES inbound_receipts (tenant_id, receipt_id)
);

CREATE TABLE inbound_deliveries (
  delivery_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  destination_key_hash bytea NOT NULL CHECK (octet_length(destination_key_hash) = 32),
  state text NOT NULL CHECK (state IN ('ready', 'delivering', 'retry_wait', 'delivered', 'dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  optimistic_version bigint NOT NULL DEFAULT 0 CHECK (optimistic_version >= 0),
  next_action_at timestamptz,
  claimed_until timestamptz,
  delivered_at timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, delivery_id),
  UNIQUE (tenant_id, receipt_id, destination_key_hash),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES inbound_receipts (tenant_id, receipt_id),
  CHECK (updated_at >= created_at)
);

CREATE INDEX inbound_deliveries_due
  ON inbound_deliveries (next_action_at, delivery_id)
  WHERE state IN ('ready', 'delivering', 'retry_wait');

CREATE TABLE outbound_intents (
  intent_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  idempotency_key_hash bytea NOT NULL CHECK (octet_length(idempotency_key_hash) = 32),
  idempotency_key_ciphertext bytea NOT NULL CHECK (octet_length(idempotency_key_ciphertext) > 0),
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  raw_blob_id uuid NOT NULL,
  transmission_blob_id uuid NOT NULL,
  envelope jsonb NOT NULL,
  route_plan jsonb NOT NULL,
  state text NOT NULL CHECK (
    state IN (
      'accepted', 'ready', 'dispatching', 'retry_wait', 'provider_accepted',
      'failed_not_sent', 'quarantined_unknown', 'canceled'
    )
  ),
  current_attempt_id uuid,
  optimistic_version bigint NOT NULL DEFAULT 0 CHECK (optimistic_version >= 0),
  next_action_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, intent_id),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, raw_blob_id) REFERENCES raw_blobs (tenant_id, blob_id),
  FOREIGN KEY (tenant_id, transmission_blob_id) REFERENCES raw_blobs (tenant_id, blob_id),
  CHECK (jsonb_typeof(envelope) = 'object' AND envelope ->> 'schemaVersion' = 'v1'),
  CHECK (jsonb_typeof(route_plan) = 'object' AND route_plan ->> 'schemaVersion' = 'v1'),
  CHECK (updated_at >= created_at)
);

CREATE INDEX outbound_intents_due
  ON outbound_intents (next_action_at, intent_id)
  WHERE state IN ('accepted', 'ready', 'retry_wait');

CREATE TABLE outbound_attempts (
  attempt_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  binding_id uuid NOT NULL,
  binding_version bigint NOT NULL,
  recipient_group jsonb NOT NULL CHECK (jsonb_typeof(recipient_group) = 'object'),
  recipient_group_digest bytea NOT NULL CHECK (octet_length(recipient_group_digest) = 32),
  transmission_blob_id uuid NOT NULL,
  fence bigint NOT NULL CHECK (fence > 0),
  state text NOT NULL CHECK (
    state IN ('dispatching', 'provider_accepted', 'retry_wait', 'failed_not_sent', 'quarantined_unknown')
  ),
  certainty text NOT NULL CHECK (certainty IN ('not_sent', 'accepted', 'unknown')),
  provider_message_id_ciphertext bytea,
  provider_message_id_hash bytea CHECK (
    provider_message_id_hash IS NULL OR octet_length(provider_message_id_hash) = 32
  ),
  dispatch_boundary_at timestamptz,
  claimed_until timestamptz,
  next_action_at timestamptz,
  response_evidence jsonb CHECK (response_evidence IS NULL OR jsonb_typeof(response_evidence) = 'object'),
  provider_acceptance jsonb CHECK (
    provider_acceptance IS NULL
    OR (jsonb_typeof(provider_acceptance) = 'object' AND provider_acceptance ->> 'schemaVersion' = 'v1')
  ),
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (tenant_id, attempt_id),
  UNIQUE (tenant_id, intent_id, ordinal),
  UNIQUE (tenant_id, intent_id, fence),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES outbound_intents (tenant_id, intent_id),
  FOREIGN KEY (tenant_id, binding_id, binding_version)
    REFERENCES route_bindings (tenant_id, binding_id, binding_version),
  FOREIGN KEY (tenant_id, transmission_blob_id) REFERENCES raw_blobs (tenant_id, blob_id),
  CHECK ((state = 'provider_accepted') = (certainty = 'accepted')),
  CHECK ((state = 'quarantined_unknown') = (certainty = 'unknown')),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE UNIQUE INDEX outbound_attempts_one_live_group
  ON outbound_attempts (tenant_id, intent_id, recipient_group_digest)
  WHERE state IN ('dispatching', 'retry_wait');

ALTER TABLE outbound_intents
  ADD CONSTRAINT outbound_intents_current_attempt_fk
  FOREIGN KEY (tenant_id, current_attempt_id)
  REFERENCES outbound_attempts (tenant_id, attempt_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE outbound_attempt_recipients (
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  recipient_key_hash bytea NOT NULL CHECK (octet_length(recipient_key_hash) = 32),
  outcome text NOT NULL CHECK (
    outcome IN ('pending', 'accepted', 'rejected', 'delivered', 'deferred', 'bounced', 'complained')
  ),
  status_code text CHECK (status_code IS NULL OR octet_length(status_code) BETWEEN 1 AND 32),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, recipient_key_hash),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES outbound_attempts (tenant_id, attempt_id)
);

CREATE TABLE recipient_delivery_projection (
  tenant_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  recipient_key_hash bytea NOT NULL CHECK (octet_length(recipient_key_hash) = 32),
  transport_state text NOT NULL CHECK (
    transport_state IN ('pending', 'accepted', 'delivered', 'deferred', 'bounced', 'failed_not_sent', 'unknown')
  ),
  complaint boolean NOT NULL DEFAULT false,
  suppressed boolean NOT NULL DEFAULT false,
  opened boolean NOT NULL DEFAULT false,
  clicked boolean NOT NULL DEFAULT false,
  unsubscribed boolean NOT NULL DEFAULT false,
  last_transport_occurred_at timestamptz,
  latest_feedback_order_key text,
  contradictions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(contradictions) = 'array'),
  optimistic_version bigint NOT NULL DEFAULT 0 CHECK (optimistic_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, intent_id, recipient_key_hash),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES outbound_intents (tenant_id, intent_id)
);

CREATE TABLE reconciliation_decisions (
  decision_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted', 'failed_not_sent', 'authorized_retry')),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_digest bytea NOT NULL CHECK (octet_length(evidence_digest) = 32),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  actor text NOT NULL CHECK (octet_length(actor) BETWEEN 1 AND 256),
  expected_intent_version bigint NOT NULL CHECK (expected_intent_version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, decision_id),
  UNIQUE (tenant_id, attempt_id, evidence_digest),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES outbound_intents (tenant_id, intent_id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES outbound_attempts (tenant_id, attempt_id)
);

CREATE TABLE provider_feedback_events (
  feedback_event_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  provider_instance_id uuid NOT NULL,
  attempt_id uuid,
  provider_message_id_hash bytea CHECK (
    provider_message_id_hash IS NULL OR octet_length(provider_message_id_hash) = 32
  ),
  recipient_key_hash bytea CHECK (
    recipient_key_hash IS NULL OR octet_length(recipient_key_hash) = 32
  ),
  kind text NOT NULL CHECK (
    kind IN ('accepted', 'delivered', 'deferred', 'bounced', 'complained', 'suppressed', 'opened', 'clicked', 'unsubscribed')
  ),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  order_key text NOT NULL CHECK (octet_length(order_key) BETWEEN 1 AND 512),
  normalized jsonb NOT NULL CHECK (jsonb_typeof(normalized) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (feedback_event_id, received_at),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, provider_instance_id)
    REFERENCES provider_instances (tenant_id, provider_instance_id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES outbound_attempts (tenant_id, attempt_id)
) PARTITION BY RANGE (received_at);

CREATE TABLE provider_feedback_events_default
  PARTITION OF provider_feedback_events DEFAULT;

CREATE INDEX provider_feedback_events_tenant_attempt
  ON provider_feedback_events (tenant_id, attempt_id, occurred_at);

CREATE TABLE provider_feedback_dedup (
  tenant_id uuid NOT NULL,
  provider_instance_id uuid NOT NULL,
  provider_event_key_hash bytea NOT NULL CHECK (octet_length(provider_event_key_hash) = 32),
  feedback_event_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, provider_instance_id, provider_event_key_hash),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, provider_instance_id)
    REFERENCES provider_instances (tenant_id, provider_instance_id)
);

CREATE TABLE webhook_replay_nonces (
  tenant_id uuid NOT NULL,
  provider_instance_id uuid NOT NULL,
  nonce_hash bytea NOT NULL CHECK (octet_length(nonce_hash) = 32),
  body_digest bytea CHECK (body_digest IS NULL OR octet_length(body_digest) = 32),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, provider_instance_id, nonce_hash),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, provider_instance_id)
    REFERENCES provider_instances (tenant_id, provider_instance_id),
  CHECK (expires_at > created_at)
);

CREATE INDEX webhook_replay_nonces_expiry ON webhook_replay_nonces (expires_at);

CREATE TABLE audit_events (
  audit_id uuid NOT NULL,
  tenant_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('system', 'operator', 'application')),
  actor_id_hash bytea NOT NULL CHECK (octet_length(actor_id_hash) = 32),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{0,95}$'),
  target_type text NOT NULL CHECK (target_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  target_id uuid,
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  before_digest bytea CHECK (before_digest IS NULL OR octet_length(before_digest) = 32),
  after_digest bytea CHECK (after_digest IS NULL OR octet_length(after_digest) = 32),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (audit_id, occurred_at),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_events_default PARTITION OF audit_events DEFAULT;

CREATE INDEX audit_events_tenant_occurred ON audit_events (tenant_id, occurred_at);

CREATE TABLE workflow_wakeup_watermarks (
  tenant_id uuid NOT NULL,
  workflow_name text NOT NULL CHECK (
    workflow_name IN ('inbound_receipt', 'outbound_intent', 'feedback_event', 'application_delivery')
  ),
  last_scan_at timestamptz NOT NULL,
  cursor jsonb NOT NULL CHECK (jsonb_typeof(cursor) = 'object'),
  fence bigint NOT NULL CHECK (fence >= 0),
  PRIMARY KEY (tenant_id, workflow_name),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
);

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'tenants',
    'domain_claims',
    'provider_instances',
    'route_bindings',
    'route_binding_checks',
    'blob_ingest_stages',
    'raw_blobs',
    'raw_blob_derivations',
    'legal_holds',
    'blob_deletions',
    'inbound_receipts',
    'inbound_receipt_dedup',
    'inbound_deliveries',
    'outbound_intents',
    'outbound_attempts',
    'outbound_attempt_recipients',
    'recipient_delivery_projection',
    'reconciliation_decisions',
    'provider_feedback_events',
    'provider_feedback_dedup',
    'webhook_replay_nonces',
    'audit_events',
    'workflow_wakeup_watermarks'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = mail_edge_current_tenant_id()) WITH CHECK (tenant_id = mail_edge_current_tenant_id())',
      tenant_table
    );
  END LOOP;
END
$$;

COMMENT ON FUNCTION mail_edge_current_tenant_id() IS
  'Transaction-local tenant identifier used by request-scoped RLS policies.';

COMMENT ON TABLE workflow_wakeup_watermarks IS
  'Durable repair cursors; queue jobs remain lossy scheduling hints.';
