CREATE TABLE raw_access_grants (
  grant_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  blob_id uuid NOT NULL,
  audience text NOT NULL CHECK (
    octet_length(audience) BETWEEN 1 AND 128
    AND audience ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  ),
  operation text NOT NULL CHECK (operation = 'raw_download'),
  subject_id text NOT NULL CHECK (
    octet_length(subject_id) BETWEEN 1 AND 128
    AND subject_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  ),
  purpose text NOT NULL CHECK (
    purpose IN ('application_delivery', 'operator_review', 'reconciliation')
  ),
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  single_use boolean NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'consumed', 'revoked', 'expired')),
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  last_authorized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id),
  FOREIGN KEY (tenant_id, blob_id) REFERENCES raw_blobs (tenant_id, blob_id),
  UNIQUE (tenant_id, grant_id),
  UNIQUE (tenant_id, token_hash),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes'),
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE INDEX raw_access_grants_subject_active
  ON raw_access_grants (tenant_id, purpose, subject_id, expires_at)
  WHERE state = 'active';

CREATE INDEX raw_access_grants_expiry
  ON raw_access_grants (expires_at)
  WHERE state = 'active';

CREATE TRIGGER raw_access_grants_available_blob
  BEFORE INSERT OR UPDATE OF blob_id ON raw_access_grants
  FOR EACH ROW EXECUTE FUNCTION mail_edge_require_available_blob('blob_id');

ALTER TABLE raw_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON raw_access_grants
  USING (tenant_id = mail_edge_current_tenant_id())
  WITH CHECK (tenant_id = mail_edge_current_tenant_id());

CREATE TABLE quarantine_control_decisions (
  decision_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workflow_type text NOT NULL CHECK (workflow_type IN ('inbound_receipt', 'outbound_intent')),
  workflow_id uuid NOT NULL,
  attempt_id uuid,
  action text NOT NULL CHECK (
    action IN ('release', 'terminal', 'resolve_accepted', 'resolve_not_sent', 'authorize_retry')
  ),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  actor_id_hash bytea NOT NULL CHECK (octet_length(actor_id_hash) = 32),
  expected_version bigint NOT NULL CHECK (expected_version >= 0),
  expected_fence bigint CHECK (expected_fence IS NULL OR expected_fence >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, decision_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
);

CREATE INDEX quarantine_control_decisions_workflow
  ON quarantine_control_decisions (tenant_id, workflow_type, workflow_id, created_at DESC);

ALTER TABLE quarantine_control_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quarantine_control_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON quarantine_control_decisions
  USING (tenant_id = mail_edge_current_tenant_id())
  WITH CHECK (tenant_id = mail_edge_current_tenant_id());

CREATE FUNCTION mail_edge_locate_raw_access_grant(requested_grant_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT tenant_id
  FROM public.raw_access_grants
  WHERE grant_id = requested_grant_id
$$;

REVOKE ALL ON FUNCTION mail_edge_locate_raw_access_grant(uuid) FROM PUBLIC;

ALTER TABLE provider_feedback_events
  ADD COLUMN application_next_action_at timestamptz,
  ADD COLUMN application_failure_count integer NOT NULL DEFAULT 0
    CHECK (application_failure_count >= 0),
  ADD COLUMN application_acknowledgement jsonb
    CHECK (
      application_acknowledgement IS NULL
      OR jsonb_typeof(application_acknowledgement) = 'object'
    ),
  ADD COLUMN application_terminal_at timestamptz,
  ADD COLUMN application_last_error_code text;

DROP INDEX provider_feedback_events_application_due;
CREATE INDEX provider_feedback_events_application_due
  ON provider_feedback_events (
    tenant_id,
    projected_at,
    application_terminal_at,
    application_next_action_at,
    claimed_until,
    received_at,
    feedback_event_id
  )
  WHERE projected_at IS NULL AND application_terminal_at IS NULL;

DROP VIEW raw_blob_reference_summary;
DROP VIEW raw_blob_references;

CREATE VIEW raw_blob_references
WITH (security_barrier = true, security_invoker = true)
AS
  SELECT tenant_id, raw_blob_id AS blob_id, 'inbound_receipt'::text AS reference_kind
    FROM inbound_receipts
    WHERE raw_blob_id IS NOT NULL AND state <> 'purged'
  UNION ALL
  SELECT tenant_id, raw_blob_id, 'outbound_intent_source'
    FROM outbound_intents
  UNION ALL
  SELECT tenant_id, transmission_blob_id, 'outbound_intent_transmission'
    FROM outbound_intents
  UNION ALL
  SELECT tenant_id, transmission_blob_id, 'outbound_attempt_transmission'
    FROM outbound_attempts
  UNION ALL
  SELECT tenant_id, source_blob_id, 'derivation_source'
    FROM raw_blob_derivations
  UNION ALL
  SELECT tenant_id, derived_blob_id, 'derivation_output'
    FROM raw_blob_derivations
  UNION ALL
  SELECT tenant_id, blob_id, 'legal_hold'
    FROM legal_holds
    WHERE released_at IS NULL
  UNION ALL
  SELECT tenant_id, blob_id, 'raw_access_grant'
    FROM raw_access_grants
    WHERE state = 'active' AND expires_at > clock_timestamp();

CREATE VIEW raw_blob_reference_summary
WITH (security_barrier = true, security_invoker = true)
AS
  SELECT tenant_id, blob_id, count(*)::bigint AS reference_count
  FROM raw_blob_references
  GROUP BY tenant_id, blob_id;

COMMENT ON TABLE raw_access_grants IS
  'Short-lived tenant, audience, subject, operation, and blob-bound raw streaming authority.';
COMMENT ON TABLE quarantine_control_decisions IS
  'Privileged optimistic and fenced decisions for quarantined inbound and outbound workflows.';
COMMENT ON COLUMN raw_access_grants.token_hash IS
  'Tenant-scoped HMAC digest; the bearer token is never persisted.';
COMMENT ON COLUMN raw_access_grants.fence IS
  'Monotonic authorization/revocation fence used to reject stale consumption.';
COMMENT ON FUNCTION mail_edge_locate_raw_access_grant(uuid) IS
  'Resolves only a grant tenant before a tenant-scoped RLS transaction begins.';
