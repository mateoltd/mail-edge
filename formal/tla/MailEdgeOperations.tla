---------------------------- MODULE MailEdgeOperations ----------------------------
EXTENDS Integers, FiniteSets, TLC

CONSTANTS Tenants, Domains, Directions, Bindings, Intents, Attempts,
          MaxFence, MaxQueueMultiplicity

ASSUME /\ Tenants = {1, 2}
       /\ Domains = {1, 2}
       /\ Directions = {"outbound"}
       /\ Bindings = {1, 2, 3}
       /\ Intents = {1}
       /\ Attempts = {1, 2, 3}
       /\ MaxFence = 3
       /\ MaxQueueMultiplicity = 2

NoValue == 0

BindingTenant(b) == IF b \in {1, 2} THEN 1 ELSE 2
BindingDomain(b) == IF b \in {1, 2} THEN 1 ELSE 2
BindingDirection(b) == "outbound"
BindingIdentity(b) == IF b \in {1, 2} THEN "binding-a" ELSE "binding-b"
BindingGeneration(b) == IF b = 2 THEN 2 ELSE 1
BindingRoute(b) == <<BindingTenant(b), BindingDomain(b), BindingDirection(b)>>

IntentTenant(i) == i
IntentDomain(i) == i
IntentDirection(i) == "outbound"
IntentRoute(i) == <<IntentTenant(i), IntentDomain(i), IntentDirection(i)>>

BindingStates == {"testing", "active", "draining"}
IntentStates == {"absent", "accepted", "ready", "dispatching", "retry_wait",
                  "provider_accepted", "failed_not_sent", "quarantined_unknown"}
AttemptStates == {"unused", "dispatching", "retry_wait", "provider_accepted",
                   "failed_not_sent", "quarantined_unknown"}
Certainties == {"not_sent", "accepted", "unknown"}
Evidence == {"none", "unsupported", "inconclusive", "authoritative_accepted",
             "authoritative_not_sent"}
ReconciledOutcomes == {"none", "accepted", "not_sent"}
AttemptOrigins == {"none", "initial", "proved_not_sent_retry",
                    "explicit_unknown_retry"}

BumpQueue(n) == IF n < MaxQueueMultiplicity THEN n + 1 ELSE n

VARIABLES bindingState,
          intentState, intentPinned, pinnedAtCreation, currentAttempt, intentFence,
          retryAuthorized, queueDepth,
          attemptState, attemptIntent, attemptFence, attemptBinding, attemptCertainty,
          boundaryCrossed, providerCalled, reconciliationEvidence, reconciledOutcome,
          attemptOrigin

vars == <<bindingState,
          intentState, intentPinned, pinnedAtCreation, currentAttempt, intentFence,
          retryAuthorized, queueDepth,
          attemptState, attemptIntent, attemptFence, attemptBinding, attemptCertainty,
          boundaryCrossed, providerCalled, reconciliationEvidence, reconciledOutcome,
          attemptOrigin>>

Init ==
  /\ bindingState = [b \in Bindings |-> IF b \in {1, 3} THEN "active" ELSE "testing"]
  /\ intentState = [i \in Intents |-> "absent"]
  /\ intentPinned = [i \in Intents |-> NoValue]
  /\ pinnedAtCreation = [i \in Intents |-> NoValue]
  /\ currentAttempt = [i \in Intents |-> NoValue]
  /\ intentFence = [i \in Intents |-> 0]
  /\ retryAuthorized = [i \in Intents |-> FALSE]
  /\ queueDepth = [i \in Intents |-> 0]
  /\ attemptState = [a \in Attempts |-> "unused"]
  /\ attemptIntent = [a \in Attempts |-> NoValue]
  /\ attemptFence = [a \in Attempts |-> 0]
  /\ attemptBinding = [a \in Attempts |-> NoValue]
  /\ attemptCertainty = [a \in Attempts |-> "not_sent"]
  /\ boundaryCrossed = [a \in Attempts |-> FALSE]
  /\ providerCalled = [a \in Attempts |-> FALSE]
  /\ reconciliationEvidence = [a \in Attempts |-> "none"]
  /\ reconciledOutcome = [a \in Attempts |-> "none"]
  /\ attemptOrigin = [a \in Attempts |-> "none"]

ActivateGeneration(b) ==
  /\ bindingState[b] = "testing"
  /\ \E old \in Bindings:
       /\ old # b
       /\ BindingRoute(old) = BindingRoute(b)
       /\ bindingState[old] = "active"
  /\ bindingState' =
       [x \in Bindings |->
          IF x = b
          THEN "active"
          ELSE IF BindingRoute(x) = BindingRoute(b) /\ bindingState[x] = "active"
               THEN "draining"
               ELSE bindingState[x]]
  /\ UNCHANGED <<intentState, intentPinned, pinnedAtCreation, currentAttempt,
                  intentFence, retryAuthorized, queueDepth,
                  attemptState, attemptIntent, attemptFence, attemptBinding,
                  attemptCertainty, boundaryCrossed, providerCalled,
                  reconciliationEvidence, reconciledOutcome, attemptOrigin>>

CreateIntent(i, b) ==
  /\ intentState[i] = "absent"
  /\ bindingState[b] = "active"
  /\ BindingRoute(b) = IntentRoute(i)
  /\ intentState' = [intentState EXCEPT ![i] = "accepted"]
  /\ intentPinned' = [intentPinned EXCEPT ![i] = b]
  /\ pinnedAtCreation' = [pinnedAtCreation EXCEPT ![i] = b]
  /\ queueDepth' = [queueDepth EXCEPT ![i] = 1]
  /\ UNCHANGED <<bindingState, currentAttempt, intentFence, retryAuthorized,
                  attemptState, attemptIntent, attemptFence, attemptBinding,
                  attemptCertainty, boundaryCrossed, providerCalled,
                  reconciliationEvidence, reconciledOutcome, attemptOrigin>>

LoseWakeup(i) ==
  /\ queueDepth[i] > 0
  /\ queueDepth' = [queueDepth EXCEPT ![i] = @ - 1]
  /\ UNCHANGED <<bindingState, intentState, intentPinned, pinnedAtCreation,
                  currentAttempt, intentFence, retryAuthorized,
                  attemptState, attemptIntent, attemptFence, attemptBinding,
                  attemptCertainty, boundaryCrossed, providerCalled,
                  reconciliationEvidence, reconciledOutcome, attemptOrigin>>

DuplicateWakeup(i) ==
  /\ queueDepth[i] > 0
  /\ queueDepth[i] < MaxQueueMultiplicity
  /\ queueDepth' = [queueDepth EXCEPT ![i] = @ + 1]
  /\ UNCHANGED <<bindingState, intentState, intentPinned, pinnedAtCreation,
                  currentAttempt, intentFence, retryAuthorized,
                  attemptState, attemptIntent, attemptFence, attemptBinding,
                  attemptCertainty, boundaryCrossed, providerCalled,
                  reconciliationEvidence, reconciledOutcome, attemptOrigin>>

RepairWakeup(i) ==
  /\ intentState[i] \in {"accepted", "ready", "retry_wait"}
  /\ queueDepth[i] = 0
  /\ queueDepth' = [queueDepth EXCEPT ![i] = 1]
  /\ UNCHANGED <<bindingState, intentState, intentPinned, pinnedAtCreation,
                  currentAttempt, intentFence, retryAuthorized,
                  attemptState, attemptIntent, attemptFence, attemptBinding,
                  attemptCertainty, boundaryCrossed, providerCalled,
                  reconciliationEvidence, reconciledOutcome, attemptOrigin>>

ConsumeStaleWakeup(i) ==
  /\ queueDepth[i] > 0
  /\ intentState[i] \notin {"accepted", "ready", "retry_wait"}
  /\ queueDepth' = [queueDepth EXCEPT ![i] = @ - 1]
  /\ UNCHANGED <<bindingState, intentState, intentPinned, pinnedAtCreation,
                  currentAttempt, intentFence, retryAuthorized,
                  attemptState, attemptIntent, attemptFence, attemptBinding,
                  attemptCertainty, boundaryCrossed, providerCalled,
                  reconciliationEvidence, reconciledOutcome, attemptOrigin>>

DurableClaimDispatch(i, a) ==
  /\ intentState[i] \in {"accepted", "ready", "retry_wait"}
  /\ intentState[i] = "ready" => retryAuthorized[i]
  /\ queueDepth[i] > 0
  /\ intentFence[i] < MaxFence
  /\ attemptState[a] = "unused"
  /\ intentState' = [intentState EXCEPT ![i] = "dispatching"]
  /\ currentAttempt' = [currentAttempt EXCEPT ![i] = a]
  /\ intentFence' = [intentFence EXCEPT ![i] = @ + 1]
  /\ retryAuthorized' = [retryAuthorized EXCEPT ![i] = FALSE]
  /\ queueDepth' = [queueDepth EXCEPT ![i] = @ - 1]
  /\ attemptState' = [attemptState EXCEPT ![a] = "dispatching"]
  /\ attemptIntent' = [attemptIntent EXCEPT ![a] = i]
  /\ attemptFence' = [attemptFence EXCEPT ![a] = intentFence[i] + 1]
  /\ attemptBinding' = [attemptBinding EXCEPT ![a] = intentPinned[i]]
  /\ attemptCertainty' = [attemptCertainty EXCEPT ![a] = "not_sent"]
  /\ boundaryCrossed' = [boundaryCrossed EXCEPT ![a] = FALSE]
  /\ providerCalled' = [providerCalled EXCEPT ![a] = FALSE]
  /\ reconciliationEvidence' = [reconciliationEvidence EXCEPT ![a] = "none"]
  /\ reconciledOutcome' = [reconciledOutcome EXCEPT ![a] = "none"]
  /\ attemptOrigin' =
       [attemptOrigin EXCEPT
          ![a] = IF intentState[i] = "accepted"
                THEN "initial"
                ELSE IF intentState[i] = "retry_wait"
                     THEN "proved_not_sent_retry"
                     ELSE "explicit_unknown_retry"]
  /\ UNCHANGED <<bindingState, intentPinned, pinnedAtCreation>>

BeginProviderCall(a) ==
  /\ attemptState[a] = "dispatching"
  /\ currentAttempt[attemptIntent[a]] = a
  /\ intentFence[attemptIntent[a]] = attemptFence[a]
  /\ ~providerCalled[a]
  /\ providerCalled' = [providerCalled EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<bindingState, intentState, intentPinned, pinnedAtCreation,
                  currentAttempt, intentFence, retryAuthorized, queueDepth,
                  attemptState, attemptIntent, attemptFence, attemptBinding,
                  attemptCertainty, boundaryCrossed, reconciliationEvidence,
                  reconciledOutcome, attemptOrigin>>

CrossTransmissionBoundary(a) ==
  /\ attemptState[a] = "dispatching"
  /\ providerCalled[a]
  /\ ~boundaryCrossed[a]
  /\ boundaryCrossed' = [boundaryCrossed EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<bindingState, intentState, intentPinned, pinnedAtCreation,
                  currentAttempt, intentFence, retryAuthorized, queueDepth,
                  attemptState, attemptIntent, attemptFence, attemptBinding,
                  attemptCertainty, providerCalled, reconciliationEvidence,
                  reconciledOutcome, attemptOrigin>>

SettleAccepted(a) ==
  LET i == attemptIntent[a] IN
  /\ attemptState[a] = "dispatching"
  /\ currentAttempt[i] = a
  /\ intentFence[i] = attemptFence[a]
  /\ providerCalled[a]
  /\ boundaryCrossed[a]
  /\ intentState' = [intentState EXCEPT ![i] = "provider_accepted"]
  /\ attemptState' = [attemptState EXCEPT ![a] = "provider_accepted"]
  /\ attemptCertainty' = [attemptCertainty EXCEPT ![a] = "accepted"]
  /\ UNCHANGED <<bindingState, intentPinned, pinnedAtCreation, currentAttempt,
                  intentFence, retryAuthorized, queueDepth, attemptIntent,
                  attemptFence, attemptBinding, boundaryCrossed, providerCalled,
                  reconciliationEvidence, reconciledOutcome, attemptOrigin>>

SettleProvedNotSent(a, retry) ==
  LET i == attemptIntent[a] IN
  /\ retry \in BOOLEAN
  /\ attemptState[a] = "dispatching"
  /\ currentAttempt[i] = a
  /\ intentFence[i] = attemptFence[a]
  /\ providerCalled[a]
  /\ ~boundaryCrossed[a]
  /\ intentState' =
       [intentState EXCEPT ![i] = IF retry THEN "retry_wait" ELSE "failed_not_sent"]
  /\ attemptState' =
       [attemptState EXCEPT ![a] = IF retry THEN "retry_wait" ELSE "failed_not_sent"]
  /\ attemptCertainty' = [attemptCertainty EXCEPT ![a] = "not_sent"]
  /\ queueDepth' =
       IF retry THEN [queueDepth EXCEPT ![i] = BumpQueue(@)] ELSE queueDepth
  /\ UNCHANGED <<bindingState, intentPinned, pinnedAtCreation, currentAttempt,
                  intentFence, retryAuthorized, attemptIntent, attemptFence,
                  attemptBinding, boundaryCrossed, providerCalled,
                  reconciliationEvidence, reconciledOutcome, attemptOrigin>>

SettleUnknown(a) ==
  LET i == attemptIntent[a] IN
  /\ attemptState[a] = "dispatching"
  /\ currentAttempt[i] = a
  /\ intentFence[i] = attemptFence[a]
  /\ providerCalled[a]
  /\ intentState' = [intentState EXCEPT ![i] = "quarantined_unknown"]
  /\ attemptState' = [attemptState EXCEPT ![a] = "quarantined_unknown"]
  /\ attemptCertainty' = [attemptCertainty EXCEPT ![a] = "unknown"]
  /\ UNCHANGED <<bindingState, intentPinned, pinnedAtCreation, currentAttempt,
                  intentFence, retryAuthorized, queueDepth, attemptIntent,
                  attemptFence, attemptBinding, boundaryCrossed, providerCalled,
                  reconciliationEvidence, reconciledOutcome, attemptOrigin>>

CrashOrLeaseExpire(a) ==
  LET i == attemptIntent[a] IN
  /\ attemptState[a] = "dispatching"
  /\ currentAttempt[i] = a
  /\ intentFence[i] = attemptFence[a]
  /\ intentState' = [intentState EXCEPT ![i] = "quarantined_unknown"]
  /\ attemptState' = [attemptState EXCEPT ![a] = "quarantined_unknown"]
  /\ attemptCertainty' = [attemptCertainty EXCEPT ![a] = "unknown"]
  /\ UNCHANGED <<bindingState, intentPinned, pinnedAtCreation, currentAttempt,
                  intentFence, retryAuthorized, queueDepth, attemptIntent,
                  attemptFence, attemptBinding, boundaryCrossed, providerCalled,
                  reconciliationEvidence, reconciledOutcome, attemptOrigin>>

RecordReconciliationEvidence(a, evidence) ==
  /\ evidence \in Evidence \ {"none"}
  /\ attemptState[a] = "quarantined_unknown"
  /\ reconciliationEvidence' = [reconciliationEvidence EXCEPT ![a] = evidence]
  /\ UNCHANGED <<bindingState, intentState, intentPinned, pinnedAtCreation,
                  currentAttempt, intentFence, retryAuthorized, queueDepth,
                  attemptState, attemptIntent, attemptFence, attemptBinding,
                  attemptCertainty, boundaryCrossed, providerCalled,
                  reconciledOutcome, attemptOrigin>>

ReconcileAccepted(a) ==
  LET i == attemptIntent[a] IN
  /\ attemptState[a] = "quarantined_unknown"
  /\ intentState[i] = "quarantined_unknown"
  /\ currentAttempt[i] = a
  /\ intentFence[i] = attemptFence[a]
  /\ reconciliationEvidence[a] = "authoritative_accepted"
  /\ intentState' = [intentState EXCEPT ![i] = "provider_accepted"]
  /\ attemptState' = [attemptState EXCEPT ![a] = "provider_accepted"]
  /\ attemptCertainty' = [attemptCertainty EXCEPT ![a] = "accepted"]
  /\ reconciledOutcome' = [reconciledOutcome EXCEPT ![a] = "accepted"]
  /\ UNCHANGED <<bindingState, intentPinned, pinnedAtCreation, currentAttempt,
                  intentFence, retryAuthorized, queueDepth, attemptIntent,
                  attemptFence, attemptBinding, boundaryCrossed, providerCalled,
                  reconciliationEvidence, attemptOrigin>>

ReconcileNotSent(a) ==
  LET i == attemptIntent[a] IN
  /\ attemptState[a] = "quarantined_unknown"
  /\ intentState[i] = "quarantined_unknown"
  /\ currentAttempt[i] = a
  /\ intentFence[i] = attemptFence[a]
  /\ reconciliationEvidence[a] = "authoritative_not_sent"
  /\ intentState' = [intentState EXCEPT ![i] = "failed_not_sent"]
  /\ attemptState' = [attemptState EXCEPT ![a] = "failed_not_sent"]
  /\ attemptCertainty' = [attemptCertainty EXCEPT ![a] = "not_sent"]
  /\ reconciledOutcome' = [reconciledOutcome EXCEPT ![a] = "not_sent"]
  /\ UNCHANGED <<bindingState, intentPinned, pinnedAtCreation, currentAttempt,
                  intentFence, retryAuthorized, queueDepth, attemptIntent,
                  attemptFence, attemptBinding, boundaryCrossed, providerCalled,
                  reconciliationEvidence, attemptOrigin>>

AuthorizeRetry(i) ==
  /\ intentState[i] = "quarantined_unknown"
  /\ currentAttempt[i] # NoValue
  /\ attemptState[currentAttempt[i]] = "quarantined_unknown"
  /\ intentFence[i] = attemptFence[currentAttempt[i]]
  /\ intentState' = [intentState EXCEPT ![i] = "ready"]
  /\ currentAttempt' = [currentAttempt EXCEPT ![i] = NoValue]
  /\ retryAuthorized' = [retryAuthorized EXCEPT ![i] = TRUE]
  /\ queueDepth' = [queueDepth EXCEPT ![i] = BumpQueue(@)]
  /\ UNCHANGED <<bindingState, intentPinned, pinnedAtCreation, intentFence,
                  attemptState, attemptIntent, attemptFence, attemptBinding,
                  attemptCertainty, boundaryCrossed, providerCalled,
                  reconciliationEvidence, reconciledOutcome, attemptOrigin>>

\* Planned fallback bindings are not persisted or selected by production. This action is
\* deliberately unreachable and is not part of the refinement relation.
FallbackDispatch(i, a) == FALSE

Next ==
  \/ \E b \in Bindings: ActivateGeneration(b)
  \/ \E i \in Intents, b \in Bindings: CreateIntent(i, b)
  \/ \E i \in Intents: LoseWakeup(i)
  \/ \E i \in Intents: DuplicateWakeup(i)
  \/ \E i \in Intents: RepairWakeup(i)
  \/ \E i \in Intents: ConsumeStaleWakeup(i)
  \/ \E i \in Intents, a \in Attempts: DurableClaimDispatch(i, a)
  \/ \E a \in Attempts: BeginProviderCall(a)
  \/ \E a \in Attempts: CrossTransmissionBoundary(a)
  \/ \E a \in Attempts: SettleAccepted(a)
  \/ \E a \in Attempts, retry \in BOOLEAN: SettleProvedNotSent(a, retry)
  \/ \E a \in Attempts: SettleUnknown(a)
  \/ \E a \in Attempts: CrashOrLeaseExpire(a)
  \/ \E a \in Attempts, evidence \in Evidence: RecordReconciliationEvidence(a, evidence)
  \/ \E a \in Attempts: ReconcileAccepted(a)
  \/ \E a \in Attempts: ReconcileNotSent(a)
  \/ \E i \in Intents: AuthorizeRetry(i)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ bindingState \in [Bindings -> BindingStates]
  /\ intentState \in [Intents -> IntentStates]
  /\ intentPinned \in [Intents -> (Bindings \cup {NoValue})]
  /\ pinnedAtCreation \in [Intents -> (Bindings \cup {NoValue})]
  /\ currentAttempt \in [Intents -> (Attempts \cup {NoValue})]
  /\ intentFence \in [Intents -> 0..MaxFence]
  /\ retryAuthorized \in [Intents -> BOOLEAN]
  /\ queueDepth \in [Intents -> 0..MaxQueueMultiplicity]
  /\ attemptState \in [Attempts -> AttemptStates]
  /\ attemptIntent \in [Attempts -> (Intents \cup {NoValue})]
  /\ attemptFence \in [Attempts -> 0..MaxFence]
  /\ attemptBinding \in [Attempts -> (Bindings \cup {NoValue})]
  /\ attemptCertainty \in [Attempts -> Certainties]
  /\ boundaryCrossed \in [Attempts -> BOOLEAN]
  /\ providerCalled \in [Attempts -> BOOLEAN]
  /\ reconciliationEvidence \in [Attempts -> Evidence]
  /\ reconciledOutcome \in [Attempts -> ReconciledOutcomes]
  /\ attemptOrigin \in [Attempts -> AttemptOrigins]

BindingGenerationIdentity ==
  /\ BindingIdentity(1) = BindingIdentity(2)
  /\ BindingGeneration(1) # BindingGeneration(2)
  /\ BindingRoute(1) = BindingRoute(2)
  /\ \A b1, b2 \in Bindings:
       BindingIdentity(b1) = BindingIdentity(b2) /\
       BindingGeneration(b1) = BindingGeneration(b2) => b1 = b2

OneActiveExactRoute ==
  \A b1, b2 \in Bindings:
    b1 # b2 /\ BindingRoute(b1) = BindingRoute(b2) =>
      ~(bindingState[b1] = "active" /\ bindingState[b2] = "active")

PinnedGenerationImmutable ==
  \A i \in Intents:
    intentState[i] # "absent" =>
      /\ intentPinned[i] \in Bindings
      /\ intentPinned[i] = pinnedAtCreation[i]
      /\ BindingRoute(intentPinned[i]) = IntentRoute(i)

NoFallbackRefinement ==
  \A a \in Attempts:
    attemptState[a] # "unused" =>
      /\ attemptIntent[a] \in Intents
      /\ attemptBinding[a] = intentPinned[attemptIntent[a]]
      /\ attemptOrigin[a] # "fallback"

CurrentAttemptIntegrity ==
  /\ \A i \in Intents:
       currentAttempt[i] # NoValue =>
         /\ attemptIntent[currentAttempt[i]] = i
         /\ attemptFence[currentAttempt[i]] = intentFence[i]
  /\ \A i \in Intents:
       intentState[i] = "dispatching" =>
         /\ currentAttempt[i] # NoValue
         /\ attemptState[currentAttempt[i]] = "dispatching"

FenceMonotonic ==
  /\ \A a \in Attempts:
       attemptState[a] # "unused" =>
         /\ attemptFence[a] > 0
         /\ attemptFence[a] <= intentFence[attemptIntent[a]]
  /\ \A a1, a2 \in Attempts:
       a1 # a2 /\ attemptState[a1] # "unused" /\ attemptState[a2] # "unused" /\
       attemptIntent[a1] = attemptIntent[a2] => attemptFence[a1] # attemptFence[a2]

DurableBeforeProviderCall ==
  \A a \in Attempts:
    providerCalled[a] =>
      /\ attemptState[a] # "unused"
      /\ attemptIntent[a] \in Intents
      /\ attemptFence[a] > 0
      /\ attemptBinding[a] = intentPinned[attemptIntent[a]]

CrossedBoundaryNeverProvedNotSent ==
  \A a \in Attempts:
    boundaryCrossed[a] /\ attemptState[a] # "dispatching" =>
      \/ attemptCertainty[a] \in {"accepted", "unknown"}
      \/ /\ attemptCertainty[a] = "not_sent"
         /\ reconciledOutcome[a] = "not_sent"
         /\ reconciliationEvidence[a] = "authoritative_not_sent"

QuarantineIntegrity ==
  \A i \in Intents:
    intentState[i] = "quarantined_unknown" =>
      /\ currentAttempt[i] # NoValue
      /\ attemptState[currentAttempt[i]] = "quarantined_unknown"
      /\ attemptCertainty[currentAttempt[i]] = "unknown"

AuthoritativeReconciliation ==
  \A a \in Attempts:
    /\ reconciledOutcome[a] = "accepted" =>
         /\ reconciliationEvidence[a] = "authoritative_accepted"
         /\ attemptState[a] = "provider_accepted"
         /\ attemptCertainty[a] = "accepted"
    /\ reconciledOutcome[a] = "not_sent" =>
         /\ reconciliationEvidence[a] = "authoritative_not_sent"
         /\ attemptState[a] = "failed_not_sent"
         /\ attemptCertainty[a] = "not_sent"

UnknownRetryRequiresExplicitAuthority ==
  \A i \in Intents, old \in Attempts:
    /\ attemptIntent[old] = i
    /\ attemptState[old] = "quarantined_unknown"
    /\ currentAttempt[i] # NoValue
    /\ attemptFence[currentAttempt[i]] > attemptFence[old]
    => \E authorized \in Attempts:
         /\ attemptIntent[authorized] = i
         /\ attemptOrigin[authorized] = "explicit_unknown_retry"
         /\ attemptFence[authorized] > attemptFence[old]
         /\ attemptFence[authorized] <= attemptFence[currentAttempt[i]]

AcceptedIsConsistent ==
  \A i \in Intents:
    intentState[i] = "provider_accepted" =>
      /\ currentAttempt[i] # NoValue
      /\ attemptState[currentAttempt[i]] = "provider_accepted"
      /\ attemptCertainty[currentAttempt[i]] = "accepted"

=============================================================================
