-------------------------- MODULE TrustScope --------------------------
EXTENDS Naturals, TLC
CONSTANT PackageManagerRootKey
Roots == {"session", "adopted"}
Trusts == {"scoped", "trusted"}
Key(r, t) == <<IF PackageManagerRootKey THEN r ELSE "ambient", t>>
Keys == {Key(r, t) : r \in Roots, t \in Trusts}
Probes == [root : Roots, trust : Trusts]
VARIABLES root, trust, cache, flights, lastRead
vars == <<root, trust, cache, flights, lastRead>>
Init == /\ root = "session" /\ trust = "scoped"
        /\ cache = [k \in Keys |-> "empty"] /\ flights = {}
        /\ lastRead = <<"session", "session">>
SwitchRoot == /\ root' \in Roots
              /\ UNCHANGED <<trust, cache, flights, lastRead>>
SwitchTrust == /\ trust' \in Trusts
               /\ UNCHANGED <<root, cache, flights, lastRead>>
Start == /\ flights' = flights \cup {[root |-> root, trust |-> trust]}
         /\ UNCHANGED <<root, trust, cache, lastRead>>
Settle == \E p \in flights:
          /\ cache' = [cache EXCEPT ![Key(p.root, p.trust)] = p.root]
          /\ flights' = flights \ {p}
          /\ UNCHANGED <<root, trust, lastRead>>
Read == /\ cache[Key(root, trust)] # "empty"
        /\ lastRead' = <<root, cache[Key(root, trust)]>>
        /\ UNCHANGED <<root, trust, cache, flights>>
Next == SwitchRoot \/ SwitchTrust \/ Start \/ Settle \/ Read
Spec == Init /\ [][Next]_vars
NoCrossRootAnswer == lastRead[1] = lastRead[2]
=============================================================================
