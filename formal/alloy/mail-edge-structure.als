module mail_edge_structure

abstract sig Direction {}
one sig Inbound, Outbound extends Direction {}

sig Tenant {}
sig CanonicalALabel {}

sig DomainClaim {
  domainTenant: one Tenant,
  canonicalLabel: one CanonicalALabel
}

sig ProviderInstanceId {}
sig ProviderId {}

sig ProviderInstance {
  providerInstanceId: one ProviderInstanceId,
  providerId: one ProviderId,
  providerTenant: one Tenant
}

sig BindingId {}
sig BindingGeneration {}

abstract sig BindingState {}
one sig Testing, Active, Draining, Retired, Failed extends BindingState {}

sig Binding {
  bindingId: one BindingId,
  generation: one BindingGeneration,
  bindingTenant: one Tenant,
  domainClaim: one DomainClaim,
  direction: one Direction,
  provider: one ProviderInstance,
  bindingState: one BindingState
}

abstract sig BlobStatus {}
one sig Available, Corrupt, PurgePending, Deleted extends BlobStatus {}

abstract sig RetentionState {}
one sig RetentionFuture, RetentionDue extends RetentionState {}

abstract sig OrphanObservationState {}
one sig NotObservedTwice, ObservedTwice extends OrphanObservationState {}

sig Blob {
  blobTenant: one Tenant,
  blobStatus: one BlobStatus,
  retentionState: one RetentionState,
  orphanObservationState: one OrphanObservationState
}

abstract sig ReceiptRawState {}
one sig ReceiptRetained, ReceiptPurged extends ReceiptRawState {}

sig InboundReceipt {
  receiptTenant: one Tenant,
  receiptRaw: one Blob,
  receiptRawState: one ReceiptRawState
}

sig OutboundIntent {
  intentTenant: one Tenant,
  primaryBinding: one Binding,
  fallbackBindings: set Binding,
  sourceRaw: one Blob,
  transmissionRaw: one Blob
}

sig OutboundAttempt {
  attemptTenant: one Tenant,
  intent: one OutboundIntent,
  routeBinding: one Binding,
  attemptTransmissionRaw: one Blob
}

sig Derivation {
  derivationTenant: one Tenant,
  sourceBlob: one Blob,
  derivedBlob: one Blob
}

abstract sig HoldState {}
one sig HoldOpen, HoldReleased extends HoldState {}
sig HoldActor {}
sig ReleaseEpoch {}

sig LegalHold {
  holdTenant: one Tenant,
  heldBlob: one Blob,
  holdState: one HoldState,
  releasedBy: lone HoldActor,
  releasedAt: lone ReleaseEpoch
}

abstract sig GrantState {}
one sig GrantActive, GrantRevoked extends GrantState {}
abstract sig GrantExpiry {}
one sig GrantUnexpired, GrantExpired extends GrantExpiry {}

sig RawAccessGrant {
  grantTenant: one Tenant,
  grantedBlob: one Blob,
  grantState: one GrantState,
  grantExpiry: one GrantExpiry
}

abstract sig DeletionState {}
one sig DeleteClaimed, DeleteRetryWait, ObjectDeleted, DeleteCompleted, DeleteFailed
  extends DeletionState {}
abstract sig PurgeBasis {}
one sig RetentionBasis, TwiceObservedOrphanBasis extends PurgeBasis {}
sig DeleteFence {}

sig Deletion {
  deletionTenant: one Tenant,
  deletedBlob: one Blob,
  deleteFence: one DeleteFence,
  deletionState: one DeletionState,
  purgeBasis: one PurgeBasis
}

fun retainedReceiptBlobs: set Blob {
  { b: Blob | some r: InboundReceipt |
      r.receiptRaw = b and r.receiptRawState = ReceiptRetained }
}

fun openHeldBlobs: set Blob {
  { b: Blob | some h: LegalHold | h.heldBlob = b and h.holdState = HoldOpen }
}

fun activeGrantBlobs: set Blob {
  { b: Blob | some g: RawAccessGrant |
      g.grantedBlob = b and g.grantState = GrantActive and
      g.grantExpiry = GrantUnexpired }
}

fun referencedBlobs: set Blob {
  retainedReceiptBlobs +
  OutboundIntent.sourceRaw +
  OutboundIntent.transmissionRaw +
  OutboundAttempt.attemptTransmissionRaw +
  Derivation.sourceBlob +
  Derivation.derivedBlob +
  openHeldBlobs +
  activeGrantBlobs
}

pred purgeEligible[b: Blob] {
  b.blobStatus = Available
  b.retentionState = RetentionDue or b.orphanObservationState = ObservedTwice
  b not in referencedBlobs
}

fact DomainClaimIdentity {
  all disj left, right: DomainClaim |
    left.domainTenant = right.domainTenant implies
      left.canonicalLabel != right.canonicalLabel
}

fact BindingIdentityAndTenantClosure {
  all disj left, right: ProviderInstance |
    left.providerInstanceId != right.providerInstanceId
  all disj left, right: Binding |
    left.bindingId = right.bindingId implies left.generation != right.generation
  all b: Binding |
    b.bindingTenant = b.domainClaim.domainTenant and
    b.bindingTenant = b.provider.providerTenant
  all disj left, right: Binding |
    left.bindingTenant = right.bindingTenant and
    left.domainClaim = right.domainClaim and
    left.direction = right.direction and
    left.bindingState = Active implies right.bindingState != Active
}

fact WorkflowPinsAndReferenceTenantClosure {
  no OutboundIntent.fallbackBindings
  all i: OutboundIntent |
    i.intentTenant = i.primaryBinding.bindingTenant and
    i.intentTenant = i.sourceRaw.blobTenant and
    i.intentTenant = i.transmissionRaw.blobTenant
  all a: OutboundAttempt |
    a.attemptTenant = a.intent.intentTenant and
    a.routeBinding = a.intent.primaryBinding and
    a.attemptTransmissionRaw = a.intent.transmissionRaw and
    a.attemptTenant = a.attemptTransmissionRaw.blobTenant
  all r: InboundReceipt | r.receiptTenant = r.receiptRaw.blobTenant
  all d: Derivation |
    d.derivationTenant = d.sourceBlob.blobTenant and
    d.derivationTenant = d.derivedBlob.blobTenant and
    d.sourceBlob != d.derivedBlob
}

fact HoldAndGrantIntegrity {
  all h: LegalHold | h.holdTenant = h.heldBlob.blobTenant
  all h: LegalHold |
    (h.holdState = HoldOpen implies no h.releasedBy and no h.releasedAt) and
    (h.holdState = HoldReleased implies one h.releasedBy and one h.releasedAt)
  all disj left, right: LegalHold |
    left.holdTenant = right.holdTenant and left.heldBlob = right.heldBlob and
    left.holdState = HoldOpen implies right.holdState != HoldOpen
  all g: RawAccessGrant | g.grantTenant = g.grantedBlob.blobTenant
}

fact LiveReferencesBlockPurgeAndCreationAfterClaim {
  all b: referencedBlobs | b.blobStatus in Available + Corrupt
}

fact DeletionIntegrity {
  all d: Deletion | d.deletionTenant = d.deletedBlob.blobTenant
  all disj left, right: Deletion | left.deletedBlob != right.deletedBlob
  all d: Deletion |
    d.purgeBasis = RetentionBasis implies d.deletedBlob.retentionState = RetentionDue
  all d: Deletion |
    d.purgeBasis = TwiceObservedOrphanBasis implies
      d.deletedBlob.orphanObservationState = ObservedTwice
  all d: Deletion | d.deletedBlob not in referencedBlobs
  all d: Deletion |
    d.deletionState in DeleteClaimed + DeleteRetryWait + ObjectDeleted implies
      d.deletedBlob.blobStatus = PurgePending
  all d: Deletion |
    d.deletionState = DeleteCompleted implies d.deletedBlob.blobStatus = Deleted
  all b: Blob |
    b.blobStatus = PurgePending implies
      one d: Deletion |
        d.deletedBlob = b and
        d.deletionState in DeleteClaimed + DeleteRetryWait + ObjectDeleted
  all b: Blob |
    b.blobStatus = Deleted iff
      one d: Deletion | d.deletedBlob = b and d.deletionState = DeleteCompleted
}

assert DomainClaimsAreUnique {
  all disj left, right: DomainClaim |
    left.domainTenant = right.domainTenant implies
      left.canonicalLabel != right.canonicalLabel
}

assert BindingGenerationsAreUnique {
  all disj left, right: Binding |
    left.bindingId = right.bindingId implies left.generation != right.generation
}

assert ProviderInstancesAreUnique {
  all disj left, right: ProviderInstance |
    left.providerInstanceId != right.providerInstanceId
}

assert OneActiveExactBinding {
  all disj left, right: Binding |
    left.bindingTenant = right.bindingTenant and
    left.domainClaim = right.domainClaim and
    left.direction = right.direction and
    left.bindingState = Active implies right.bindingState != Active
}

assert BindingTenantClosed {
  all b: Binding |
    b.bindingTenant = b.domainClaim.domainTenant and
    b.bindingTenant = b.provider.providerTenant
}

assert OutboundPinsExactPrimaryWithNoFallback {
  no OutboundIntent.fallbackBindings
  all a: OutboundAttempt |
    a.routeBinding = a.intent.primaryBinding and
    a.attemptTransmissionRaw = a.intent.transmissionRaw
}

assert AllReferencesAreTenantClosed {
  all r: InboundReceipt | r.receiptTenant = r.receiptRaw.blobTenant
  all i: OutboundIntent |
    i.intentTenant = i.sourceRaw.blobTenant and
    i.intentTenant = i.transmissionRaw.blobTenant
  all a: OutboundAttempt | a.attemptTenant = a.attemptTransmissionRaw.blobTenant
  all d: Derivation |
    d.derivationTenant = d.sourceBlob.blobTenant and
    d.derivationTenant = d.derivedBlob.blobTenant
  all h: LegalHold | h.holdTenant = h.heldBlob.blobTenant
  all g: RawAccessGrant | g.grantTenant = g.grantedBlob.blobTenant
}

assert DerivationEndpointsAreDistinctAndTenantClosed {
  all d: Derivation |
    d.sourceBlob != d.derivedBlob and
    d.derivationTenant = d.sourceBlob.blobTenant and
    d.derivationTenant = d.derivedBlob.blobTenant
}

assert OpenHoldIsUniquePerTenantBlob {
  all disj left, right: LegalHold |
    left.holdTenant = right.holdTenant and left.heldBlob = right.heldBlob and
    left.holdState = HoldOpen implies right.holdState != HoldOpen
}

assert HeldBlobCannotBePurgeEligible {
  no b: openHeldBlobs | purgeEligible[b]
}

assert ReferencedBlobCannotBePurgeEligible {
  no b: referencedBlobs | purgeEligible[b]
}

assert PurgePendingRejectsReferencesAndOpenHolds {
  no b: Blob |
    b.blobStatus = PurgePending and
    (b in referencedBlobs or b in openHeldBlobs)
}

assert DeletedBlobHasExactlyOneCompletedDeletion {
  all b: Blob |
    b.blobStatus = Deleted iff
      one d: Deletion | d.deletedBlob = b and d.deletionState = DeleteCompleted
}

assert DeletionClaimHasOneFenceAndNoReferences {
  all d: Deletion |
    one d.deleteFence and d.deletedBlob not in referencedBlobs
  all disj left, right: Deletion | left.deletedBlob != right.deletedBlob
}

pred WitnessBindingGenerationSwitch {
  some disj old, next: Binding |
    old.bindingId = next.bindingId and
    old.generation != next.generation and
    old.bindingTenant = next.bindingTenant and
    old.domainClaim = next.domainClaim and
    old.direction = next.direction and
    old.bindingState = Draining and next.bindingState = Active
}

pred WitnessHeldAvailableBlob {
  some h: LegalHold |
    h.holdState = HoldOpen and h.heldBlob.blobStatus = Available
}

pred WitnessCompletedDeletion {
  some d: Deletion |
    d.deletionState = DeleteCompleted and d.deletedBlob.blobStatus = Deleted
}

pred WitnessActiveGrantReference {
  some g: RawAccessGrant |
    g.grantState = GrantActive and
    g.grantExpiry = GrantUnexpired and
    g.grantedBlob in referencedBlobs
}

check DomainClaimsAreUnique for 6 but exactly 2 Tenant, exactly 3 DomainClaim,
  exactly 3 ProviderInstance, exactly 5 Binding, exactly 4 Blob expect 0
check BindingGenerationsAreUnique for 6 but exactly 2 Tenant, exactly 3 DomainClaim,
  exactly 3 ProviderInstance, exactly 5 Binding, exactly 4 Blob expect 0
check ProviderInstancesAreUnique for 6 but exactly 2 Tenant, exactly 3 DomainClaim,
  exactly 3 ProviderInstance, exactly 5 Binding, exactly 4 Blob expect 0
check OneActiveExactBinding for 6 but exactly 2 Tenant, exactly 3 DomainClaim,
  exactly 3 ProviderInstance, exactly 5 Binding, exactly 4 Blob expect 0
check BindingTenantClosed for 6 but exactly 2 Tenant, exactly 3 DomainClaim,
  exactly 3 ProviderInstance, exactly 5 Binding, exactly 4 Blob expect 0
check OutboundPinsExactPrimaryWithNoFallback for 6 but exactly 2 Tenant,
  exactly 3 DomainClaim, exactly 3 ProviderInstance, exactly 5 Binding,
  exactly 4 Blob, exactly 3 OutboundIntent, exactly 4 OutboundAttempt expect 0
check AllReferencesAreTenantClosed for 6 but exactly 2 Tenant, exactly 3 DomainClaim,
  exactly 3 ProviderInstance, exactly 5 Binding, exactly 4 Blob,
  exactly 3 OutboundIntent, exactly 4 OutboundAttempt, exactly 2 InboundReceipt,
  exactly 2 Derivation, exactly 3 LegalHold, exactly 3 RawAccessGrant expect 0
check DerivationEndpointsAreDistinctAndTenantClosed for 6 but exactly 2 Tenant,
  exactly 4 Blob, exactly 2 Derivation expect 0
check OpenHoldIsUniquePerTenantBlob for 6 but exactly 2 Tenant, exactly 4 Blob,
  exactly 3 LegalHold expect 0
check HeldBlobCannotBePurgeEligible for 6 but exactly 2 Tenant, exactly 4 Blob,
  exactly 3 LegalHold, exactly 3 RawAccessGrant, exactly 3 Deletion expect 0
check ReferencedBlobCannotBePurgeEligible for 6 but exactly 2 Tenant, exactly 4 Blob,
  exactly 3 OutboundIntent, exactly 4 OutboundAttempt, exactly 2 InboundReceipt,
  exactly 2 Derivation, exactly 3 LegalHold, exactly 3 RawAccessGrant,
  exactly 3 Deletion expect 0
check PurgePendingRejectsReferencesAndOpenHolds for 6 but exactly 2 Tenant,
  exactly 4 Blob, exactly 3 LegalHold, exactly 3 RawAccessGrant, exactly 3 Deletion expect 0
check DeletedBlobHasExactlyOneCompletedDeletion for 6 but exactly 2 Tenant,
  exactly 4 Blob, exactly 3 Deletion expect 0
check DeletionClaimHasOneFenceAndNoReferences for 6 but exactly 2 Tenant,
  exactly 4 Blob, exactly 3 Deletion expect 0

run WitnessBindingGenerationSwitch for 6 but exactly 2 Tenant, exactly 3 DomainClaim,
  exactly 3 ProviderInstance, exactly 5 Binding, exactly 4 Blob expect 1
run WitnessHeldAvailableBlob for 6 but exactly 2 Tenant, exactly 4 Blob,
  exactly 3 LegalHold expect 1
run WitnessCompletedDeletion for 6 but exactly 2 Tenant, exactly 4 Blob,
  exactly 3 Deletion expect 1
run WitnessActiveGrantReference for 6 but exactly 2 Tenant, exactly 4 Blob,
  exactly 3 RawAccessGrant expect 1
