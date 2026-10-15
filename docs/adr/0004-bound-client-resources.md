---
status: accepted
---

# Client file addresses use the binding and real filesystem paths

Client file addresses always resolve through the session's manually selected
binding, rather than allowing an agent to select another device in the URI.
Their path portion represents the bound device's real filesystem path, not a
separate project/downloads alias mapping.

The implementation must retain actual device provenance with file snapshots and
results: an unchanged textual URI after a binding switch must not make a snapshot
from one device authorize an edit on another.
