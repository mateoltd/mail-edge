-- Provider-neutral W5-W8 runtime composition and exact orchestration fences.

ALTER TABLE route_bindings
  ADD COLUMN adapter_mode text NOT NULL DEFAULT 'default'
    CHECK (adapter_mode ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD COLUMN dispatch_transport text NOT NULL DEFAULT 'http'
    CHECK (dispatch_transport IN ('http', 'smtp'));

-- Existing immutable snapshots must gain the runtime authority chosen for their binding version.
UPDATE outbound_attempts AS attempt
SET route_snapshot = attempt.route_snapshot || jsonb_build_object(
  'adapterMode', binding.adapter_mode,
  'dispatchTransport', binding.dispatch_transport
)
FROM route_bindings AS binding
WHERE binding.tenant_id = attempt.tenant_id
  AND binding.binding_id = attempt.binding_id
  AND binding.binding_version = attempt.binding_version;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM outbound_intents AS intent
    LEFT JOIN route_bindings AS binding
      ON binding.tenant_id = intent.tenant_id
      AND binding.binding_id = (intent.route_plan #>> '{primaryBinding,bindingId}')::uuid
      AND binding.binding_version = (intent.route_plan #>> '{primaryBinding,bindingVersion}')::bigint
    WHERE binding.binding_id IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM outbound_intents AS intent
    CROSS JOIN LATERAL jsonb_array_elements(intent.route_plan -> 'fallbackBindings')
      AS fallback(snapshot)
    LEFT JOIN route_bindings AS binding
      ON binding.tenant_id = intent.tenant_id
      AND binding.binding_id = (fallback.snapshot ->> 'bindingId')::uuid
      AND binding.binding_version = (fallback.snapshot ->> 'bindingVersion')::bigint
    WHERE binding.binding_id IS NULL
  ) THEN
    RAISE EXCEPTION 'outbound route plan references a missing immutable binding version'
      USING ERRCODE = '23503';
  END IF;
END
$$;

UPDATE outbound_intents AS intent
SET route_plan = jsonb_set(
  jsonb_set(
    intent.route_plan,
    '{primaryBinding,adapterMode}',
    to_jsonb(binding.adapter_mode),
    true
  ),
  '{primaryBinding,dispatchTransport}',
  to_jsonb(binding.dispatch_transport),
  true
)
FROM route_bindings AS binding
WHERE binding.tenant_id = intent.tenant_id
  AND binding.binding_id = (intent.route_plan #>> '{primaryBinding,bindingId}')::uuid
  AND binding.binding_version = (intent.route_plan #>> '{primaryBinding,bindingVersion}')::bigint;

UPDATE outbound_intents AS intent
SET route_plan = jsonb_set(
  intent.route_plan,
  '{fallbackBindings}',
  (
    SELECT jsonb_agg(
      fallback.snapshot || jsonb_build_object(
        'adapterMode', binding.adapter_mode,
        'dispatchTransport', binding.dispatch_transport
      )
      ORDER BY fallback.ordinality
    )
    FROM jsonb_array_elements(intent.route_plan -> 'fallbackBindings') WITH ORDINALITY
      AS fallback(snapshot, ordinality)
    JOIN route_bindings AS binding
      ON binding.tenant_id = intent.tenant_id
      AND binding.binding_id = (fallback.snapshot ->> 'bindingId')::uuid
      AND binding.binding_version = (fallback.snapshot ->> 'bindingVersion')::bigint
  ),
  true
)
WHERE jsonb_array_length(intent.route_plan -> 'fallbackBindings') > 0;

ALTER TABLE inbound_deliveries
  ADD COLUMN destination_id text,
  ADD COLUMN delivery_mode text CHECK (delivery_mode IS NULL OR delivery_mode IN ('push', 'pull')),
  ADD COLUMN destination_token_ciphertext bytea
    CHECK (destination_token_ciphertext IS NULL OR octet_length(destination_token_ciphertext) > 0),
  ADD COLUMN acknowledgement jsonb CHECK (
    acknowledgement IS NULL OR jsonb_typeof(acknowledgement) = 'object'
  );

ALTER TABLE outbound_attempt_recipients
  ADD COLUMN recipient_index integer CHECK (
    recipient_index IS NULL OR recipient_index BETWEEN 0 AND 999
  );

CREATE UNIQUE INDEX outbound_attempt_recipients_index
  ON outbound_attempt_recipients (tenant_id, attempt_id, recipient_index)
  WHERE recipient_index IS NOT NULL;

ALTER TABLE outbound_attempts
  ADD COLUMN reconciliation_fence bigint NOT NULL DEFAULT 0
    CHECK (reconciliation_fence >= 0),
  ADD COLUMN reconciliation_claimed_until timestamptz,
  ADD COLUMN reconciliation_window_from timestamptz,
  ADD COLUMN reconciliation_window_to timestamptz;

ALTER TABLE reconciliation_decisions
  DROP CONSTRAINT reconciliation_decisions_decision_check,
  ADD CONSTRAINT reconciliation_decisions_decision_check CHECK (
    decision IN ('accepted', 'failed_not_sent', 'authorized_retry', 'quarantined_unknown')
  ),
  ADD COLUMN attempt_fence bigint NOT NULL DEFAULT 0 CHECK (attempt_fence >= 0),
  ADD COLUMN claim_fence bigint NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
  ADD COLUMN binding_id uuid,
  ADD COLUMN binding_version bigint,
  ADD COLUMN config_revision text,
  ADD COLUMN capability_digest bytea CHECK (
    capability_digest IS NULL OR octet_length(capability_digest) = 32
  ),
  ADD COLUMN adapter_mode text,
  ADD COLUMN observed_at timestamptz,
  ADD COLUMN resolved boolean NOT NULL DEFAULT false;

ALTER TABLE provider_feedback_dedup
  ADD COLUMN event_digest bytea CHECK (
    event_digest IS NULL OR octet_length(event_digest) = 32
  );

ALTER TABLE provider_feedback_events
  ADD COLUMN intent_id uuid,
  ADD COLUMN provider_id text,
  ADD COLUMN provider_event_key_hash bytea CHECK (
    provider_event_key_hash IS NULL OR octet_length(provider_event_key_hash) = 32
  ),
  ADD COLUMN sequence_hint bigint CHECK (sequence_hint IS NULL OR sequence_hint >= 0),
  ADD COLUMN event_ciphertext bytea CHECK (
    event_ciphertext IS NULL OR octet_length(event_ciphertext) > 0
  ),
  ADD COLUMN application_fence bigint NOT NULL DEFAULT 0 CHECK (application_fence >= 0),
  ADD COLUMN claimed_until timestamptz;

CREATE INDEX provider_feedback_events_application_due
  ON provider_feedback_events (tenant_id, projected_at, claimed_until, received_at, feedback_event_id)
  WHERE projected_at IS NULL;

ALTER TABLE webhook_replay_nonces
  ADD COLUMN receipt_id uuid,
  ADD CONSTRAINT webhook_replay_nonces_receipt_fk
    FOREIGN KEY (tenant_id, receipt_id)
    REFERENCES inbound_receipts (tenant_id, receipt_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION mail_edge_locate_workflow(
  requested_workflow text,
  requested_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  located_tenant uuid;
BEGIN
  CASE requested_workflow
    WHEN 'inbound_receipt' THEN
      SELECT tenant_id INTO located_tenant FROM public.inbound_receipts
      WHERE receipt_id = requested_id;
    WHEN 'outbound_intent' THEN
      SELECT tenant_id INTO located_tenant FROM public.outbound_intents
      WHERE intent_id = requested_id;
    WHEN 'feedback_event' THEN
      SELECT tenant_id INTO located_tenant FROM public.provider_feedback_events
      WHERE feedback_event_id = requested_id ORDER BY received_at DESC LIMIT 1;
    WHEN 'application_delivery' THEN
      SELECT tenant_id INTO located_tenant FROM public.inbound_deliveries
      WHERE delivery_id = requested_id;
    ELSE
      RAISE EXCEPTION 'unsupported workflow locator'
        USING ERRCODE = '22023';
  END CASE;
  RETURN located_tenant;
END
$$;

CREATE FUNCTION mail_edge_active_tenants(
  after_tenant uuid,
  requested_limit integer
)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT t.tenant_id
  FROM public.tenants AS t
  WHERE t.state = 'active'
    AND (after_tenant IS NULL OR t.tenant_id > after_tenant)
    AND requested_limit BETWEEN 1 AND 1000
  ORDER BY t.tenant_id
  LIMIT requested_limit
$$;

REVOKE ALL ON FUNCTION mail_edge_locate_workflow(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION mail_edge_active_tenants(uuid, integer) FROM PUBLIC;

COMMENT ON FUNCTION mail_edge_locate_workflow(text, uuid) IS
  'Resolves only the tenant of an opaque durable workflow identifier before tenant RLS is set.';
COMMENT ON FUNCTION mail_edge_active_tenants(uuid, integer) IS
  'Bounded runtime maintenance enumeration; callers must still open one tenant transaction per task.';
COMMENT ON COLUMN outbound_attempts.reconciliation_fence IS
  'Monotonic claim fence independent from the immutable dispatch fence.';
