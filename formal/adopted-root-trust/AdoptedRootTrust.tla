----------------------- MODULE AdoptedRootTrust -----------------------
EXTENDS Naturals, FiniteSets
CONSTANT RootTrustGuard
VARIABLES session, host, saved, resources, policy, exports, kind, spawned
vars == <<session, host, saved, resources, policy, exports, kind, spawned>>
Init == /\ session \in {"trusted", "untrusted", "unknown"}
        /\ host \in {"pi", "MCP"}
        /\ saved \in {"true", "false", "none"}
        /\ resources \in BOOLEAN
        /\ policy \in {"always", "never", "ask"}
        /\ exports \in BOOLEAN
        /\ kind \in {"project-code", "inert"}
        /\ spawned = FALSE
RootTrusted == exports /\ IF saved # "none" THEN saved = "true"
                          ELSE ~resources \/ policy = "always"
EffectiveTrust == IF host = "pi" THEN RootTrusted ELSE session = "trusted"
Start == /\ ~spawned
         /\ kind = "inert" \/ (IF RootTrustGuard THEN EffectiveTrust ELSE session = "trusted")
         /\ spawned' = TRUE
         /\ UNCHANGED <<session, host, saved, resources, policy, exports, kind>>
Next == Start
Spec == Init /\ [][Next]_vars
OwnTrust == spawned /\ kind = "project-code" => EffectiveTrust
======================================================================
