---
section: Fixed
audience: user
area: blockers
---

- **A mark copied from a cascade line now hides that error.** The cascade line
  prints only the first line of an error message, cut at 100 characters, so a
  false-positive or suppress mark spelled from what the agent was shown hid
  nothing for a long or multiline error; the error kept reporting every turn.
  A mark that quotes text two live errors share still hides neither, so naming
  one message exactly drops that one alone. (refs #5367)
