------------------------ MODULE TrustLifetime ------------------------
EXTENDS Naturals
CONSTANTS BoundSdkLoad, RetirementAbort, DetachedMemoGuard
VARIABLES phase, tick, retired, saved, memo, answer, checked
vars == <<phase, tick, retired, saved, memo, answer, checked>>
Init == /\ phase = "loading" /\ tick = 0 /\ retired = FALSE
        /\ saved = FALSE /\ memo = "none" /\ answer = FALSE /\ checked = FALSE
Resolve == /\ phase = "loading" /\ ~retired
           /\ phase' = "done" /\ answer' = saved
           /\ UNCHANGED <<tick, retired, saved, memo, checked>>
Reject == /\ phase = "loading" /\ phase' = "done" /\ answer' = FALSE
          /\ UNCHANGED <<tick, retired, saved, memo, checked>>
Deadline == /\ phase = "loading" /\ tick = 0 /\ tick' = 1
            /\ phase' = IF BoundSdkLoad THEN "done" ELSE phase
            /\ answer' = FALSE
            /\ UNCHANGED <<retired, saved, memo, checked>>
Retire == /\ ~retired /\ retired' = TRUE
          /\ phase' = IF RetirementAbort THEN "done" ELSE phase
          /\ memo' = "none" /\ answer' = FALSE
          /\ UNCHANGED <<tick, saved, checked>>
ReadDetached == /\ phase = "done" /\ ~retired
                /\ answer' = IF DetachedMemoGuard \/ memo = "none"
                              THEN saved ELSE memo = "true"
                /\ memo' = IF DetachedMemoGuard THEN "none"
                            ELSE IF saved THEN "true" ELSE "false"
                /\ checked' = TRUE
                /\ UNCHANGED <<phase, tick, retired, saved>>
Grant == /\ ~saved /\ saved' = TRUE /\ checked' = FALSE
         /\ UNCHANGED <<phase, tick, retired, memo, answer>>
Next == Resolve \/ Reject \/ Deadline \/ Retire \/ ReadDetached \/ Grant
Spec == Init /\ [][Next]_vars
AwaitBounded == tick = 1 => phase = "done"
RetirementSettles == retired => phase = "done"
DetachedFresh == checked /\ ~retired => answer = saved
======================================================================
