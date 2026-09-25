---
section: Fixed
---

- A pi-lens session whose instance-registry entry went missing — its
  registration dropped because the registry lock was busy past its wait bound,
  or the registry file was cleared — now re-registers on its next heartbeat,
  using the session root it originally registered. Previously it stayed missing
  for the rest of the session, invisible to the shared-checkout guard and warm
  attach. A session that has shut down, or has stopped serving its last root,
  is never re-registered (refs #3447).
