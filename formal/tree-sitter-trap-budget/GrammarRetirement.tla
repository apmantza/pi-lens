------------------------ MODULE GrammarRetirement ------------------------
EXTENDS Naturals, FiniteSets
(***************************************************************************)
(* Per-language projection of TreeSitterClient's grammar retirement         *)
(* (#4010): `grammarTrapInputs[L]`, `retiredGrammars`, and the budget       *)
(* `wasmTraps`, for ONE language L. Round 4 of #4204.                       *)
(*                                                                          *)
(* The code (clients/tree-sitter-client.ts):                                *)
(*   reportWasmAbort    -> countGrammarTrapInput(L, key) on EVERY trap with *)
(*                         an input: add the key, retire at |set| >= T. A   *)
(*                         first trap (key not in trappedInputs) then       *)
(*                         spends one budget unit; past WASM_TRAP_BUDGET    *)
(*                         the process aborts. A second trap of the same    *)
(*                         key charges it and spends nothing.               *)
(*   clearWasmInput     -> the trapper's own success removes the key.       *)
(*   loadLanguage/getLanguage -> null for a retired grammar, so a retired   *)
(*                         grammar parses nothing and heals nothing.        *)
(*                                                                          *)
(* The environment picks, per input, whether its bytes trap every time      *)
(* (Persistent: trap, then trap again once retried, then charged) or trap   *)
(* once and parse cleanly on the retry (not Persistent: a one-off).         *)
(* Inputs are distinct bytes; an input parses at most as often as below.   *)
(*                                                                          *)
(* Invariants:                                                              *)
(*   SetIsLive   (DecayOnOwnSuccess) the grammar's set is exactly the       *)
(*               inputs that trapped and have not healed.                   *)
(*   RetiredIffTwoLive  retired exactly when T inputs were live at once:    *)
(*               never on healed one-offs, never missed (no-drop).          *)
(*   NoAbort     #4010's outcome: with at most Budget - T one-off traps     *)
(*               spending budget first, retirement comes before the abort.  *)
(***************************************************************************)
CONSTANTS Inputs, Persistent, LatchThreshold, Budget, Decay

VARIABLES status, grammarSet, retired, spent, aborted, reached
vars == <<status, grammarSet, retired, spent, aborted, reached>>

Live(st) == {i \in Inputs : st[i] \in {"trapped", "charged"}}

Init ==
    /\ status = [i \in Inputs |-> "fresh"]
    /\ grammarSet = {}
    /\ retired = FALSE
    /\ spent = 0
    /\ aborted = FALSE
    /\ reached = FALSE

\* A trap of input i. A first trap spends budget; a repeat is charged.
Trap(i) ==
    /\ ~retired
    /\ ~aborted
    /\ \/ /\ status[i] = "fresh"
          /\ status' = [status EXCEPT ![i] = "trapped"]
          /\ spent' = spent + 1
       \/ /\ status[i] = "trapped"
          /\ i \in Persistent
          /\ status' = [status EXCEPT ![i] = "charged"]
          /\ spent' = spent
    /\ grammarSet' = grammarSet \cup {i}
    /\ retired' = (retired \/ (Cardinality(grammarSet \cup {i}) >= LatchThreshold))
    /\ aborted' = (spent' > Budget)
    /\ reached' = (reached \/ (Cardinality(Live(status')) >= LatchThreshold))

\* The one-off input parses cleanly on its retry: its own success.
Heal(i) ==
    /\ ~retired
    /\ ~aborted
    /\ i \notin Persistent
    /\ status[i] = "trapped"
    /\ status' = [status EXCEPT ![i] = "healed"]
    /\ grammarSet' = IF Decay THEN grammarSet \ {i} ELSE grammarSet
    /\ UNCHANGED <<retired, spent, aborted, reached>>

Next == \E i \in Inputs : Trap(i) \/ Heal(i)
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ status \in [Inputs -> {"fresh", "trapped", "charged", "healed"}]
    /\ grammarSet \subseteq Inputs
    /\ retired \in BOOLEAN
    /\ spent \in 0..(Cardinality(Inputs))
    /\ aborted \in BOOLEAN
    /\ reached \in BOOLEAN

SetIsLive == grammarSet = Live(status)
RetiredIffTwoLive == retired = reached
NoAbort == ~aborted

\* Non-vacuity probes (their configs expect a violation).
NeverRetired == ~retired
NeverHealed == \A i \in Inputs : status[i] # "healed"
NeverCharged == \A i \in Inputs : status[i] # "charged"
============================================================================
