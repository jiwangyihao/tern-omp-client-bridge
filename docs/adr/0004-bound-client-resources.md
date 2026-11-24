---
status: accepted
---

# Client file addresses use the binding and real filesystem paths

Client file addresses use real paths on the invocation's target device.
The URI does not select or authorize a device. The separate `clientId` selects
one member of the session binding; it can be omitted only when the target is
unambiguous. There is no separate project/downloads alias mapping.

The implementation must retain actual device provenance with file snapshots and
results: an unchanged textual URI after a binding switch must not make a snapshot
from one device authorize an edit on another.
