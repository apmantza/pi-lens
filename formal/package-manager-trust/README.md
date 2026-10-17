# Package-manager trust scope (#4566 round 10)

`clients/package-manager.ts` captures the caller root and trust scope in the
availability and global-directory cache/flight key. Two roots and both admission
scopes can switch while probes are pending. A settled probe writes its captured
key; a lookup may read only its own root's answer. `Ambient.cfg` reproduces the
old root-free identity; `Scoped.cfg` checks the carried-root identity.

The model abstracts manager names, filesystem evidence, bounded FIFO eviction,
and subprocess failure. They do not change which root owns a successful answer.
Eviction only removes an answer and causes another probe. Unknown and untrusted
share admission and therefore one scope; trusted has the other scope.
