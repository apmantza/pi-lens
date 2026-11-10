---
section: Fixed
audience: user
area: rules
---

- **Four bundled rules now report far fewer false positives.**
  `array-callback-return` exempts async callbacks and
  `no-negation-in-equality-check` exempts double-negation comparisons in both
  language twins, `ts-react-antipatterns` reports only files that import a
  React or React-like hook source or contain JSX, and
  `unchecked-throwing-call` drops to `warning` with its intra-function limit
  documented. (refs #5466)
