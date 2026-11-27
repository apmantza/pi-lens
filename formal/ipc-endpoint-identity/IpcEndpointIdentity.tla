------------------------ MODULE IpcEndpointIdentity ------------------------
EXTENDS Naturals

CONSTANTS Owners, GuardWorkspaceBind, GuardClients

Families == {"workspace", "pid"}
Names == Families \X (Owners \cup {"shared"})
Name(owner, family, keeps) == <<family, IF keeps THEN owner ELSE "shared">>

VARIABLES listeners, replaced, answers
vars == <<listeners, replaced, answers>>

Init ==
    /\ listeners = [name \in Names |-> "none"]
    /\ replaced = FALSE
    /\ answers = {}

Bind(owner, family, keeps) ==
    LET name == Name(owner, family, keeps) IN
    /\ (~GuardWorkspaceBind \/ family = "pid" \/ keeps)
    /\ (family = "workspace" \/ keeps \/ listeners[name] = "none")
    /\ replaced' = (replaced \/
        (listeners[name] # "none" /\ listeners[name] # owner))
    /\ listeners' = [listeners EXCEPT ![name] = owner]
    /\ UNCHANGED answers

Dial(owner, family, keeps) ==
    LET name == Name(owner, family, keeps) IN
    /\ (~GuardClients \/ keeps)
    /\ listeners[name] # "none"
    /\ answers' = answers \cup {<<owner, listeners[name]>>}
    /\ UNCHANGED <<listeners, replaced>>

Next ==
    \/ \E owner \in Owners, family \in Families, keeps \in BOOLEAN :
        Bind(owner, family, keeps)
    \/ \E owner \in Owners, family \in Families, keeps \in BOOLEAN :
        Dial(owner, family, keeps)

TypeOK ==
    /\ listeners \in [Names -> (Owners \cup {"none"})]
    /\ replaced \in BOOLEAN
    /\ answers \subseteq Owners \X Owners

NoForeignReplacement == ~replaced
NoForeignAnswer == \A answer \in answers : answer[1] = answer[2]
KeepingNamesUsable ==
    \A owner \in Owners, family \in Families :
        /\ ENABLED Bind(owner, family, TRUE)
        /\ (listeners[Name(owner, family, TRUE)] = owner =>
            ENABLED Dial(owner, family, TRUE))

Spec == Init /\ [][Next]_vars
=============================================================================
