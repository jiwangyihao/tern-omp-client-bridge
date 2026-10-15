---
status: accepted
---

# Bind at OMP-session scope and capture the target per invocation

A remote host can have several attached Tern clients, including several viewers
of the same OMP conversation. The binding belongs to the OMP session, is changed
manually, and is synchronized to all its viewers with the switch actor and old
and new targets; it does not follow window focus or the latest message author.

A switch applies to the next tool invocation. An invocation already dispatched
keeps its original target, including later output and cancellation, so a request
cannot migrate between machines while running.

## Consequences

- New sessions start unbound; opening a session does not select a device.
- A viewer can select any authorized device, not only this device.
- Client identity and session identity require an explicit handshake. The agent
  host cannot infer the switch actor from a shared SSH username or public IP.
- Binding changes must be ordered and attributable so simultaneous viewers do
  not silently disagree about the target.
