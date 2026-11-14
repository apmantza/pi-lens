# Shape 86 detector state table

The rule admits only a loop that is not a turn-count wait because it has no
await, uses fake timers, or compares a real clock in its loop condition. Every
other counted loop containing an await is a finding, including a loop with no
exit other than its count; the rule does not classify the awaited expression.

| Form | Expected result |
| --- | --- |
| Counted `for`/`while`/`do` loop with an await and a condition/break/return/throw exit | finding |
| Counted loop with no exit besides the count whose awaited operation is a pure `Promise.resolve()` flush | finding |
| Counted loop with no exit besides the count whose awaited operation is arbitrary work | admitted by this structural pilot; not proven to be a flush |
| Counted loop with an await and a compared `Date.now`, `performance.now`, or `process.hrtime` deadline | admitted |
| Counted loop whose only await is a `vi.*Timers*Async` advance | admitted |
| Counted loop without an await | admitted |
| Collection iteration without a counter bound | admitted |
| Any alias, indirect call, or other unresolved awaited expression | finding |

The gate is fail-closed: no other form is admitted by the rule.
