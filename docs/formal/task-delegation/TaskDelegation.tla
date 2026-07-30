---- MODULE TaskDelegation ----
EXTENDS Naturals, TLC

CONSTANTS ParentProfile, ChildProfile

Profiles == { ParentProfile, ChildProfile }
FocusValues == { "parent", "child", "none" }
Phases == {
    "parent-running",
    "parent-suspended",
    "permit-reserved",
    "child-profile-selected",
    "child-created",
    "delegation-persisted",
    "child-running",
    "child-completed",
    "failed"
}
HistoryStatuses == { "active", "delegated", "completed" }

VARIABLES
    phase,
    maxConcurrency,
    permitsHeld,
    reservedPermit,
    focus,
    globalProfile,
    parentLive,
    parentLocalProfile,
    parentHistoryStatus,
    childLive,
    childLocalProfile,
    childHistoryStatus

vars == <<
    phase,
    maxConcurrency,
    permitsHeld,
    reservedPermit,
    focus,
    globalProfile,
    parentLive,
    parentLocalProfile,
    parentHistoryStatus,
    childLive,
    childLocalProfile,
    childHistoryStatus
>>

Init ==
    /\ phase = "parent-running"
    /\ maxConcurrency \in { 1, 2 }
    /\ permitsHeld = IF maxConcurrency = 2 THEN 1 ELSE 0
    /\ reservedPermit = FALSE
    /\ focus = "parent"
    /\ globalProfile = ParentProfile
    /\ parentLive = TRUE
    /\ parentLocalProfile = ParentProfile
    /\ parentHistoryStatus = "active"
    /\ childLive = FALSE
    /\ childLocalProfile = ChildProfile
    /\ childHistoryStatus = "active"

ActivePermits == permitsHeld + IF reservedPermit THEN 1 ELSE 0

ReserveFanOutPermit ==
    /\ phase = "parent-running"
    /\ maxConcurrency > 1
    /\ ActivePermits < maxConcurrency
    /\ phase' = "permit-reserved"
    /\ reservedPermit' = TRUE
    /\ UNCHANGED << maxConcurrency, permitsHeld, focus, globalProfile, parentLive, parentLocalProfile, parentHistoryStatus,
                    childLive, childLocalProfile, childHistoryStatus >>

SuspendParentForSerialDelegation ==
    /\ phase = "parent-running"
    /\ maxConcurrency = 1
    /\ phase' = "parent-suspended"
    /\ parentLive' = FALSE
    /\ focus' = "none"
    /\ UNCHANGED << maxConcurrency, permitsHeld, reservedPermit, globalProfile, parentLocalProfile, parentHistoryStatus,
                    childLive, childLocalProfile, childHistoryStatus >>

CreateChildAfterSuspendSucceeds ==
    /\ phase = "parent-suspended"
    /\ phase' = "child-created"
    /\ focus' = "child"
    /\ globalProfile' = ChildProfile
    /\ childLive' = TRUE
    /\ childLocalProfile' = ChildProfile
    /\ childHistoryStatus' = "active"
    /\ UNCHANGED << maxConcurrency, permitsHeld, reservedPermit, parentLive, parentLocalProfile, parentHistoryStatus >>

CreateChildAfterSuspendFails ==
    /\ phase = "parent-suspended"
    /\ phase' = "failed"
    /\ parentLive' = TRUE
    /\ focus' = "parent"
    /\ UNCHANGED << maxConcurrency, permitsHeld, reservedPermit, globalProfile, parentLocalProfile, parentHistoryStatus,
                    childLive, childLocalProfile, childHistoryStatus >>

SelectChildProfile ==
    /\ phase = "permit-reserved"
    /\ phase' = "child-profile-selected"
    /\ globalProfile' = ChildProfile
    /\ UNCHANGED << maxConcurrency, permitsHeld, reservedPermit, focus, parentLive, parentLocalProfile, parentHistoryStatus,
                    childLive, childLocalProfile, childHistoryStatus >>

CreateChildSucceeds ==
    /\ phase = "child-profile-selected"
    /\ phase' = "child-created"
    /\ focus' = "child"
    /\ childLive' = TRUE
    /\ childLocalProfile' = globalProfile
    /\ childHistoryStatus' = "active"
    /\ UNCHANGED << maxConcurrency, permitsHeld, reservedPermit, globalProfile, parentLive, parentLocalProfile, parentHistoryStatus >>

CreateChildFails ==
    /\ phase = "child-profile-selected"
    /\ phase' = "failed"
    /\ reservedPermit' = FALSE
    /\ focus' = "parent"
    /\ globalProfile' = ParentProfile
    /\ childLive' = FALSE
    /\ childLocalProfile' = ChildProfile
    /\ childHistoryStatus' = "active"
    /\ UNCHANGED << maxConcurrency, permitsHeld, parentLive, parentLocalProfile, parentHistoryStatus >>

PersistDelegationSucceeds ==
    /\ phase = "child-created"
    /\ phase' = "delegation-persisted"
    /\ parentHistoryStatus' = "delegated"
    /\ UNCHANGED << maxConcurrency, permitsHeld, reservedPermit, focus, globalProfile, parentLive, parentLocalProfile,
                    childLive, childLocalProfile, childHistoryStatus >>

PersistDelegationFails ==
    /\ phase = "child-created"
    /\ phase' = "failed"
    /\ reservedPermit' = FALSE
    /\ focus' = "parent"
    /\ globalProfile' = ParentProfile
    /\ parentLive' = TRUE
    /\ childLive' = FALSE
    /\ childLocalProfile' = ChildProfile
    /\ childHistoryStatus' = "active"
    /\ UNCHANGED << maxConcurrency, permitsHeld, parentLocalProfile, parentHistoryStatus >>

StartChildWithReservation ==
    /\ phase = "delegation-persisted"
    /\ reservedPermit = TRUE
    /\ phase' = "child-running"
    /\ reservedPermit' = FALSE
    /\ permitsHeld' = permitsHeld + 1
    /\ UNCHANGED << maxConcurrency, focus, globalProfile, parentLive, parentLocalProfile, parentHistoryStatus,
                    childLive, childLocalProfile, childHistoryStatus >>

ParentContinues ==
    /\ phase = "child-running"
    /\ UNCHANGED vars

ChildUsesScopedProfile ==
    /\ phase = "child-running"
    /\ UNCHANGED vars

ChildCompletes ==
    /\ phase = "child-running"
    /\ phase' = "child-completed"
    /\ permitsHeld' = permitsHeld - 1
    /\ focus' = "parent"
    /\ childLive' = FALSE
    /\ childHistoryStatus' = "completed"
    /\ UNCHANGED << maxConcurrency, reservedPermit, globalProfile, parentLive, parentLocalProfile, parentHistoryStatus,
                    childLocalProfile >>

Next ==
    \/ ReserveFanOutPermit
    \/ SuspendParentForSerialDelegation
    \/ CreateChildAfterSuspendSucceeds
    \/ CreateChildAfterSuspendFails
    \/ SelectChildProfile
    \/ CreateChildSucceeds
    \/ CreateChildFails
    \/ PersistDelegationSucceeds
    \/ PersistDelegationFails
    \/ StartChildWithReservation
    \/ ParentContinues
    \/ ChildUsesScopedProfile
    \/ ChildCompletes

Spec == Init /\ [][Next]_vars

PermitBound == ActivePermits <= maxConcurrency
NonNegativePermits == permitsHeld >= 0
ParentProfileIsolation == parentLive => parentLocalProfile = ParentProfile
ChildProfileIsolation == childLive => childLocalProfile = ChildProfile
RollbackRestoresParent ==
    phase = "failed" => /\ reservedPermit = FALSE
                        /\ parentLive = TRUE
                        /\ focus = "parent"
RunningChildHasDelegatedParent ==
    phase = "child-running" => /\ childLive = TRUE
                               /\ parentHistoryStatus = "delegated"
FocusReferencesLiveTask ==
    /\ focus \in FocusValues
    /\ (focus = "parent" => parentLive)
    /\ (focus = "child" => childLive)

====
