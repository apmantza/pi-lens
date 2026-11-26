----------------------- MODULE ManagerProbe -----------------------
EXTENDS Naturals
CONSTANTS ScopeGuard, FinderGuard, IdentityGuard
VARIABLES admitted, linked, warm, planted, caller, executed, finderRan
vars == <<admitted, linked, warm, planted, caller, executed, finderRan>>
Init == /\ admitted \in BOOLEAN
        /\ linked \in BOOLEAN
        /\ warm \in BOOLEAN
        /\ planted \in BOOLEAN
        /\ caller \in 1..11
        /\ executed = FALSE
        /\ finderRan = FALSE
Probe == /\ ~executed /\ ~finderRan
         /\ executed' = (admitted \/ (linked /\ ~IdentityGuard)
                              \/ (warm /\ ~ScopeGuard))
         /\ finderRan' = (planted /\ (admitted \/ ~FinderGuard))
         /\ UNCHANGED <<admitted, linked, warm, planted, caller>>
Next == Probe
Spec == Init /\ [][Next]_vars
RefusedRoot == ~admitted => ~executed /\ ~finderRan
======================================================================
