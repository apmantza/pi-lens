------------------------ MODULE PrepushDrain ------------------------
EXTENDS Naturals
CONSTANT DrainBeforeCleanup
VARIABLES phase, childAlive, directory, interrupt
vars == <<phase, childAlive, directory, interrupt>>
Init == /\ phase = "running" /\ childAlive = TRUE
        /\ directory = TRUE /\ interrupt = "none"
Finish == /\ phase = "running" /\ childAlive
          /\ childAlive' = FALSE
          /\ UNCHANGED <<phase, directory, interrupt>>
Signal == /\ phase = "running" /\ interrupt = "none"
          /\ interrupt' \in {"SIGINT", "SIGTERM"}
          /\ phase' = IF DrainBeforeCleanup THEN "draining" ELSE "cleanup"
          /\ UNCHANGED <<childAlive, directory>>
Terminate == /\ phase = "draining" /\ childAlive
             /\ childAlive' = FALSE
             /\ UNCHANGED <<phase, directory, interrupt>>
Close == /\ phase \in {"running", "draining"} /\ ~childAlive
         /\ phase' = "cleanup"
         /\ UNCHANGED <<childAlive, directory, interrupt>>
Timeout == /\ phase = "draining" /\ childAlive
           /\ phase' = "preserved"
           /\ UNCHANGED <<childAlive, directory, interrupt>>
Cleanup == /\ phase = "cleanup" /\ directory
           /\ directory' = FALSE /\ phase' = "done"
           /\ UNCHANGED <<childAlive, interrupt>>
LateWriter == /\ childAlive /\ ~directory
              /\ directory' = TRUE
              /\ UNCHANGED <<phase, childAlive, interrupt>>
Next == Finish \/ Signal \/ Terminate \/ Close \/ Timeout \/ Cleanup \/ LateWriter
NoLiveWriterAtCleanup == ~directory => ~childAlive
TypeOK == /\ phase \in {"running", "draining", "cleanup", "done", "preserved"}
          /\ childAlive \in BOOLEAN /\ directory \in BOOLEAN
          /\ interrupt \in {"none", "SIGINT", "SIGTERM"}
Spec == Init /\ [][Next]_vars
=====================================================================
