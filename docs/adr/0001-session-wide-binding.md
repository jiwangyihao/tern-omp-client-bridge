---
status: accepted
---

# Bind at OMP-session scope and capture the target per invocation

A remote host can have several attached Tern clients, including several viewers
of the same OMP conversation. The binding belongs to the OMP session, is changed
manually, and is synchronized to all its viewers with the actor and the old
and new sets of authorized devices. It does not follow window focus or the
latest message author.

A session may bind several devices. One member can be addressed implicitly;
with two or more, each client call must explicitly name one bound device ID.
Offline members still count. We chose this over a default device because the
same path or command can be valid on two machines and mean different things.
There is no broadcast or failover. Separate calls can run on different devices
at the same time; neither changes the other's routing.

Membership changes apply to new calls. Dispatched work, cancellation,
background output and native lifecycle handles retain their original owner.

## Consequences

- New sessions start unbound; opening a session does not select a device.
- A viewer can bind a paired device. This authorizes native tool operations for
  that session under the device's native Agent and OS safety rules; there is no
  additional plugin capability-grant list.
- Client identity and session identity require an explicit handshake. The agent
  host cannot infer the switch actor from a shared SSH username or public IP.
- Binding changes must be ordered and attributable so simultaneous viewers do
  not silently disagree about the target.
