# Client-bound remote work

A remote OMP session can use capabilities of an explicitly selected Tern client
without replacing its native GUI. Human transfers originate on the client where
the user acts, independently of the agent's selected client.

## Language

**Agent host**:
The machine running the OMP session and its ordinary execution environment.
_Avoid_: local machine, when referring to the server.

**Tern client**:
A Tern application instance through which a person views and interacts with a
remote host. Several clients can view the same OMP session.
_Avoid_: SSH user, remote host.

**Client device**:
A machine that can provide its own files, execution environments, and interactive
capabilities to an OMP session.
_Avoid_: window, pane.

**This device**:
The client device on which the current Tern viewer is running. It may differ from
the device selected for agent operations.
_Avoid_: bound client, as a synonym.

**OMP session**:
The shared conversation and agent workflow hosted by OMP. It is not the same
identity as a Tern pane or a transport connection.

**Pane**:
A Tern view of a running program. Its identity provides UI context, not by itself
an OMP conversation identity.

**Authorized device**:
A client device whose operator has enabled a defined set of capabilities for the
bridge. Authorization is distinct from selection as a session's target.

**Binding**:
An OMP session's human-selected association with an authorized client device.
A session can also be unbound.
_Avoid_: last connected client, active window.

**Bound client**:
The client device selected by a session's binding for agent-initiated client
operations. It is not necessarily this device.

**Switch actor**:
The Tern client that originates a human binding change, with its paired identity
and display name. A shared server-side username does not identify this actor.

**Binding change**:
A change from one session binding to another, attributable to a switch actor.
_Avoid_: reconnect, focus change.

**Invocation target**:
The concrete machine selected for one tool invocation. It can remain the previous
bound client after the session binding has changed.

**Client operation**:
An agent-initiated tool invocation that uses a bound client's resource or
execution capability.

**Client resource**:
A file or directory on the bound client, identified using that device's real
filesystem path. Clipboard contents are not client resources.

**Device context**:
State belonging to an agent execution context on a particular client device,
such as an Eval kernel or shell environment.

**Device handle**:
A reference to a window, browser tab, screenshot frame, device connection, or
running process owned by one client device and execution context.

**Human transfer**:
A paste or drag/drop that the person initiates on this device to place selected
content in a remote OMP draft. It does not select the agent's bound client.

**Draft attachment**:
Transferred content associated with an unsent OMP prompt, rather than a submitted
message or an automatically executed tool result.

**Pairing**:
The established relationship between a client executor and a remote bridge.
Pairing establishes identity and capability access; binding selects a target for
one OMP session.
