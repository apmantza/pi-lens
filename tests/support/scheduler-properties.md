# Scheduler properties: testing every interleaving, not one

A replay test pins one interleaving: gate this send, queue that touch,
release. It proves the fix for the trace it was written from and nothing
about the trace next to it. `fc.scheduler()` from fast-check wraps the
promises the code awaits, and fast-check picks, shrinks and replays their
release order. The test then states a property: "for any ordering of these
awaits, the invariant holds."

Worked example: `tests/clients/lsp/notify-queue-properties.test.ts` (#3530),
the per-path LSP notify queue. It reds with a shrunk counterexample on each
of the queue's three historical regressions (#3481, #3477, and the #3491
close-stamp drop) re-applied as mutations, and it found three defects on
master that no replay covered (#3543, #3544, #3545).

## When to write one

Write a scheduler property instead of another replay when:

- the defect is an ordering of awaits across callers of one seam: a
  coalescing queue, a per-key serializer, a latch or generation read across
  an await (shapes 21, 22, 54 and 55);
- the seam has regressed before, or a review round found a second trace of
  the same bug;
- a TLA+ model's invariant should be checked against the JavaScript itself,
  not only the design.

Keep a replay when the bug has one order and nothing interleaves with it,
when the race is against a timer (the scheduler does not own timers; use fake
timers), or when the behavior needs a real child process.

## How

1. **Schedule the awaits the code crosses.** Hand each boundary the
   production code awaits (a JSON-RPC send, an `fs` probe) to
   `s.schedule(Promise.resolve(), label)`. Decide the result at call time
   from the test's model, and let the scheduler decide when the caller sees
   it. Nothing in the scheduled region may do real I/O: the scheduler
   releases only what it scheduled, so a real `access()` resolving
   "whenever" makes orderings non-reproducible. Mock the I/O seam
   (`vi.mock` with `importOriginal` spread) and route it through the model.
2. **Issue commands without awaiting them.** Generate a command list and pass
   it to `s.scheduleSequence(...)`. Each builder starts its operation and
   returns; if it awaited the operation, nothing could interleave with it.
3. **Drive to quiescence with a bound.** `await s.waitFor(issued.task)`, then
   repeat `await s.waitIdle()` while `s.count() > 0` or a waiter is still
   unsettled, at most a fixed number of rounds. Report a waiter that never
   settled as a property failure. Awaiting it would turn a liveness bug into
   a vitest timeout with no counterexample.
4. **Write your own oracle.** Record a wire log (every message, with its
   position in one event log) and a command log (issue and settle positions).
   Derive the expected state from those, never from the implementation's
   fields. Give every generated payload a unique identity (content `c<index>`,
   read stamp `value * 100 + index`) so each wire message names the command
   it came from.
5. **State both directions.** For every filter, write the safety property
   (it never passes stale input) and the no-drop property (it never drops
   the only fresh answer). Shape 54 is the cost of writing only one.
6. **Budget the lane.** Use a fixed `seed` and a `numRuns` that fits in about
   two seconds, and fake timers for anything the code arms. The lane seed is
   one sample: any edit to the arbitraries or `numRuns` reshuffles the draws,
   so before landing, check the property green on master over many seeds
   (the example file: seeds 1-300 at 600 runs each). A property that is only
   green at its lane seed turns an unrelated PR red later. Explore in
   batches of about 20 seeds (12,000 runs) per vitest process: larger
   batches of the example file (81 seeds in one worker, and seven
   20,000-run properties in one file) had the worker die, once with
   SIGKILL.
7. **Prove it catches what it claims.** Re-apply each historical regression
   as a mutation of the built `clients/*.js` and quote the shrunk
   counterexample. Also remove each condition in your oracle that narrows a
   property and run master over many seeds, not only the lane seed. A red
   seed proves the condition is needed. A green sample proves nothing about
   inertness: seeds 1-120 of the example file stayed green without its
   save file clause, and seed 127 did not (#3530 round 2). Delete a
   narrowing condition only with a written argument naming the other
   condition that covers every case it excludes, checked against the
   production paths that reach it, and with the multi-seed sample as
   support. A carve-out for a known, reachable defect is never deleted as
   inert. A condition that strengthens a property (it narrows a carve-out)
   stays green on master by design; prove it with the mutation it exists to
   catch.
8. **Pin findings. Do not hide them.** When the property fails on master,
   first decide whether the code or the oracle is wrong; an oracle that asks
   for something the contract never promised is narrowed, with the reason in
   its docstring. For a real defect, replay the shrunk counterexample and
   file it. If the lane must stay green, carve the finding out with a named
   predicate that cites the tracking issue number, and pin it with an
   `it.fails` replay of the counterexample's commands whose title cites the
   same issue. Keep the carve-out as narrow as the defect's own signature,
   then re-run the regression mutations: a wide carve-out hides them (#3530
   round 1: the first F2 carve-out kept the #3481 round-1 stamp drop green).
   The replay turns red when the finding is fixed, and both go with the fix.

Throw an `Error` whose message carries the event log from inside the
property. fast-check then prints the shrunk counterexample with a readable
trace, not only the scheduler's task list.
