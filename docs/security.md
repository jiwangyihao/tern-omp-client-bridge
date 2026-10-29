# Security and trust boundaries

## Trust model

This bridge connects a trusted OMP agent host to paired client devices. Manually
binding a device authorizes native tool operations for that OMP session under
the client's native Agent policy and OS permissions. It is not a security boundary
between people sharing an agent-host OS account, a root account, or a client OS
account, and does not authorize crossing an otherwise untrusted tenant boundary.

Do not expose the broker or client UI endpoint publicly, proxy them to a public
interface, or forward their bearer credentials to other users. Both listeners
bind to `127.0.0.1`; requests require private bearer credentials and reject an
`Origin` header. The client UI token stays on the client and is not sent to the
agent host. Loopback is not protection from malicious software running as the
same user, and local bearer authentication is not hardware-backed proof of a
human gesture.

The outbound transport is a separate SSH stdio connection initiated by each
client. It uses `ssh -T`, `BatchMode=yes`, `ForwardAgent=no`, and
`StrictHostKeyChecking=yes`. The operator must configure authentication and independently trust the host key. The remote relay
uses the broker's private agent-host endpoint; a client does not need an inbound
SSH server or public listener. Keep remote relay stdout free of unrelated output.

## Initialization consent

Installing/loading the Tern plugin does not authorize downloads, remote changes,
or service startup. A cold-host setup sidebar is prepared only after interface-only
consent, through Tern's already-authenticated connected-host command transport.
The client uses an owned preparation pane and a nonce-qualified result, then checks
the native block catalog. It never types deployment commands into an existing user
shell or agent pane. This isolated UI package cannot overwrite the full Bridge.

Full Bridge installation remains a separate approval inside the sidebar. Its
read-only SSH check does not add/update host keys, forward agents, establish
configured forwards, run LocalCommand hooks, or create multiplexing sockets.
Display names and opaque device identifiers are not trusted as SSH destinations.
The captured target and verified address must still match at approval; editing
the address invalidates installation consent. Only then may setup provision
private runtimes, dependencies, integrations,
and background services. It does not install OMP or Tern themselves, use sudo,
modify SSH trust, restart active conversations, or change session bindings.
Registration alone does not bind a session or authorize agent operations.

Setup logs and service credentials remain private. Public progress excludes raw
subprocess output and bearer/private-key material. Services are checked through
authenticated loopback endpoints; a PID record alone is not readiness. Healthy
manual services retain their original ownership, and older running code is not
relabeled as upgraded. Unknown stale-lock ownership requires explicit recovery
confirmation; live owners are not reclaimed.

Process and native completion callbacks only deposit receipts. They do not enumerate
hosts, read storage, parse setup JSON, refresh chrome or build dialogs. Bounded pump
stages validate and display results; missing callbacks yield an interrupted/unknown
outcome. Host views expire without fresh owner snapshots and disable consequential
controls. Neither stale UI nor a displayed next step authorizes installation.

## Device identity and shared access

Each client has an Ed25519 keypair in `identity.json`; a challenge signature binds
its device ID, label, platform and architecture. A label is not identity. Copying
that file copies identity and signing authority; use a separate state directory
and generated key for every device. Protocol 2 removes legacy capability grants;
identity migration preserves both keys and the device ID, not obsolete grants.

Signed registration prevents another device from merely claiming an existing
label/ID. It does not turn a shared server root into per-user isolation. Anyone
with sufficient server-account access can access broker metadata, modify installed
code, and act through that trusted account. There is no independent multi-tenant
administrative enrollment service or durable per-human authorization database.
Use separate OS accounts/hosts and appropriate access controls if participants
must be isolated.

The manual binding belongs to the real OMP conversation. It begins unbound and
changes through an attributed, revision-checked local UI intent. Every invocation
captures one target. URI authorities cannot select arbitrary devices. A running
invocation, its cancellation, background output, and returned handles retain the
captured device, even if a viewer changes the next target.

The native Bridge panel is host-rendered and therefore visible to other windows
of the Tern session. Its snapshots contain display information only: never the
local UI bearer, endpoint, private key, or clipboard payload. Controls are
window-routed native links, not host-side broadcasts. The originating window
checks its live panel instance and source pane before handling an action; other
windows reject the link. Owner/instance identifiers prevent accidental cross-window
routing, not malicious access by already-trusted same-account code. Closing the
panel does not revoke or cancel an existing transfer.

Native draft destinations are owned by individual authenticated OMP WebSockets,
not by a session-wide broadcast. The widget exposes only a random locator. Resolve,
bind, paste and attachment claims validate the same destination, session and draft;
even two live viewers of one OMP session cannot claim each other's draft channel.
Submission invalidates the previous token; socket closure/reconnect revokes the
old locator and pending work. A locator never authorizes device use or changes a
binding by itself. Completed or uncertain UI outcomes are correlated to the
originating receipt and displayed without replay.

Panel records are keyed by authenticated client identity plus window/instance
locators. Publication updates only a live, explicitly opened record. Host reads
and close acknowledgements require the host's private loopback bearer. Public
snapshots are whitelisted and size-bounded; stale records expire after 15 seconds.
Closed identifiers are quarantined for 60 seconds to reject delayed requests,
then reclaimed rather than exhausting a lifetime creation budget.

## Binding authorizes native tools

The plugin has no per-tool grant list or `--allow` switch. A human's manual
session binding authorizes use of the paired device's native tools; unbound
sessions cannot issue client operations. Unbinding blocks new invocations, while
already-dispatched operations retain their original target and cancellation path.

The executor reads client-local native Agent policy without rewriting it. Native
tool approvals/denials, browser/computer settings and OS permissions remain in
force. Runtime isolation does not replace local policy with server settings or
an all-allow map. Availability reports describe backend prerequisites, not grants.
Native code execution is not a filesystem, clipboard or OS sandbox.

Run the client as the intended nonprivileged interactive user. Do not run it as
root/Administrator just to avoid backend permission errors. Grant OS screen,
accessibility, browser, or device permissions only when appropriate to the actual
operation. Backend failure must not be treated as permission to switch devices,
borrow another profile, or bypass native consent.

## Two approval boundaries

The OMP extension retains native provider-facing metadata and the actual
session-scoped Settings through the host's extension lifecycle. It fails closed
if the imported Settings module differs from the host's or the correct session
policy is unavailable. A package-local or same-directory sibling policy is not a
substitute. Provider safety remains the outer native host's responsibility.

The companion additionally routes native browser/computer confirmations to the
local device UI. The operator uses **OMP: Pending client approvals** and selects
a valid displayed choice. Missing/recently inactive UI, cancellation, timeout,
disconnect, or unsupported interaction results in denial. Remote execution flags
cannot assert approval. These are native policy checks, not an additional plugin
authorization system. Binding does not auto-approve a native confirmation or
override a client-local denial.

These UI controls rely on trusted local software and private state. They do not
protect against arbitrary code already running as the same OS user or a malicious
server that the operator has authorized for broad execution. Screen/page/file
content is data, not user authorization for further side effects.

## Human transfers and local clipboard consent

Selected-file capture accepts explicit local paths. An explicit local
**Paste to remote** gesture (button, palette command or user-bound shortcut)
authorizes one clipboard capture into the destination pinned by that gesture.
The separate local endpoint accepts only `{kind:"clipboard"}` and retains
loopback-only access, private bearer authentication and Origin rejection.
There is no second product-owned approval dialog and no remote `approved` flag.
Cancellation, expiry or disconnect still prevents capture or discards a late
read; downstream checks reject a changed destination. An image is snapshotted;
otherwise plain text is returned for draft insertion without submission.
Native execution approvals and OS permissions are unchanged. No clipboard
watcher or automatic synchronization runs.
The remote execution RPC exposes native tools/context disposal, not clipboard
capture. Separately authorized Bash/Eval retains its broad OS-account authority.
Local UI bearer access is not a sandbox against malicious same-account software.

Native text/image paste is neither intercepted nor required to pass through the
bridge. The explicit paste command is supplemental. Path-looking plain text is
not interpreted as a file-upload request. The old claim that a native-paste
bypass was itself a security defect has been withdrawn.

The originating device and destination conversation/draft are fixed independently
of agent binding for bridge-managed transfers. Sources are private snapshots;
uploads use bounded chunks, ownership checks, byte counts, SHA-256 verification
and atomic publication. A generated receiving-directory README is published with
the bytes. Ordinary-file paths carry an agent-visible archival reminder and a
user notice: copy/archive into durable project storage and work on those copies.
The bridge does not choose a destination, execute file contents, or enforce a
filesystem sandbox. Files may contain hostile instructions; transfer alone does
not authorize executing them.

Images enter the host's native image-paste handling after pre-handoff validation;
they are not replaced by ordinary path prose. The native interface returns void:
handoff is not an atomic preview-completion receipt, so uncertain operations must
not be replayed automatically. Native supported path formats are PNG, JPEG, GIF
and WebP; unsupported image formats fail explicitly. Existing text/attachments
are preserved, and the bridge does not submit prompts. Native image reads and
screenshots remain separate tool-result paths subject to their permissions.

File transfer itself discloses the selected content to the agent-host account.
Verify the destination and content before pasting/dropping confidential material.
Native GUI behavior, particularly drop-to-focused-pane routing, requires platform
acceptance; consult [Compatibility](compatibility.md) rather than assuming a
synthetic integration test proves correct user interaction.

## Secrets and data at rest

State roots are private: POSIX permissions are tightened to user-only directories
and files; Windows uses native ACLs via `powershell.exe`. These are account-level
protections, not encryption at rest or protection against administrators.

Treat these as sensitive:

- `identity.json`: private device signing key and identifying metadata.
- `server.json` and `client.json`: live endpoint bearer credentials.
- `captures/`, `imports/`, and runtime artifacts: potentially confidential file
  contents, tool output, screenshots, browser data, or execution state.
- Native persistent-service state and browser profiles belonging to the executor.

Never publish these files, real connection commands, hostnames, usernames, private
paths, tokens, or keys in bug reports. Prefer a non-sensitive explicit device
`--name`. Sanitize errors and native backend output before sharing them; not all
native errors are guaranteed to be free of paths or user data. The CLI deliberately
avoids printing credential-bearing generic transport errors, but that is not a
complete data-loss-prevention mechanism.

Completed imports persist even if an editor receipt is lost or a later handoff
fails. There is no automatic reference-aware collection. Normal cleanup removes
owned partials, not completed assets referenced by drafts/conversations. Crashes
can leave partials and private snapshots. Apply an explicit retention policy and
inspect ownership/references before deletion; see [Usage](usage.md#retention-and-removal).

Selected-file captures remain tied to their originating request's cancellation
until an upload claims them. Abandonment invalidates the capture before its
private copy is removed. Claiming and invalidation are synchronous ownership
transitions, so a late request cancellation cannot delete a claimed upload's
files. This does not undo a completed remote import or erase referenced assets.

## Failure, cancellation, and revocation

No connection failure triggers automatic device failover or operation replay.
An unknown outcome can mean an operation took effect but its response was lost.
Cancellation does not undo an OS action. Inspect the original device/draft before
retrying destructive or externally visible work. Offline background notifications
are not a durable result journal.

Stop the client to stop accepting work, and restart with a smaller `--allow` list
if appropriate. Unbinding a session changes subsequent routing; it does not
revoke a running invocation or terminate existing owned services. Explicitly
persistent/detached native services may outlive context/client shutdown. Stop
those services through their native ownership-aware controls when revocation
requires it. If credentials are compromised, stop the affected services, repair
OS/SSH access, and replace compromised state only after assessing retained assets
and processes. Removing `identity.json` while the service runs is not revocation.

After an unclean broker exit, inspect `server.lock` and verify its owner is gone
before removing a stale lock. Never remove a live lock to force concurrent
brokers. Cleanup errors preserve state for diagnosis rather than pretending
all resources were removed.

## Implementation references

- [`src/config.ts`](../src/config.ts): private state, identity, endpoint validation.
- [`src/client-transport.ts`](../src/client-transport.ts): outbound SSH transport.
- [`src/client.ts`](../src/client.ts): local UI authentication, grants, approvals,
  capture/transfer entrypoints, reconnect and no-replay behavior.
- [`src/broker.ts`](../src/broker.ts): directed routing, intent ownership, broker lock.
- [`src/omp/extension.ts`](../src/omp/extension.ts): host lifecycle and safety scope.
- [`src/omp/draft.ts`](../src/omp/draft.ts),
  [`src/uploads.ts`](../src/uploads.ts): draft validation and published assets.
- [`src/runtime/`](../src/runtime/): execution isolation and native cleanup.
