# Security and trust boundaries

## Trust model

This bridge connects a trusted OMP agent host to client devices whose operators
explicitly start an executor and grant capabilities. It is not a security boundary
between people sharing an agent-host OS account, a root account, or a client OS
account. A session binding is routing and attribution, **not authorization to
cross an otherwise untrusted tenant boundary**.

Do not expose the broker or client UI endpoint publicly, proxy them to a public
interface, or forward their bearer credentials to other users. Both listeners
bind to `127.0.0.1`; requests require private bearer credentials and reject an
`Origin` header. The client UI token stays on the client and is not sent to the
agent host. Loopback is not protection from malicious software running as the
same user, and local bearer authentication is not hardware-backed proof of a
human gesture.

The outbound transport is a separate SSH stdio connection initiated by each
client. It uses `ssh -T`, `BatchMode=yes`, and `ForwardAgent=no`. The operator must
configure authentication and independently trust the host key. The remote relay
uses the broker's private agent-host endpoint; a client does not need an inbound
SSH server or public listener. Keep remote relay stdout free of unrelated output.

## Device identity and shared access

Each client has an Ed25519 keypair in `identity.json`; a challenge signature binds
its device ID, label, platform, architecture, and granted capabilities. A label is
not identity. Copying that file copies identity and signing authority; use a
separate state directory and generated key for every device.

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

## Capability grants are coarse

`--allow` is mandatory on each client start. Use `--allow none` if only human
transfers are needed. `files` grants the existing filesystem tools over paths
accessible to the executor's OS account, not just a project folder. `exec` grants
arbitrary Bash/Eval execution under that account. It is **not** a sandbox, a
restricted SSH command, a clipboard sandbox, or a filesystem capability system.

`browser` and `computer` enable the corresponding native Eval integrations;
`exec` is also needed to call Eval. `adb` is an advertised capability for use of
the installed ADB executable through execution. It does not enforce command-level
ADB restrictions. Arbitrary code granted through `exec` can call other installed
programs or OS APIs regardless of whether those convenience integrations are
enabled. Browser profiles, clipboard data, private files, network access, and
device access may therefore be reachable to separately authorized code.

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
cannot assert approval. Not every file/exec call asks again locally: starting the
client with those grants is the coarse authorization, while the native host's
applicable policy still applies.

These UI controls rely on trusted local software and private state. They do not
protect against arbitrary code already running as the same OS user or a malicious
server that the operator has authorized for broad execution. Screen/page/file
content is data, not user authorization for further side effects.

## Human transfers and image restriction

The local capture endpoint accepts only explicit selected-file paths; malformed or
programmatic clipboard requests are rejected before capture. No bridge-owned path
reads or classifies the ambient clipboard. The Paste override and its asynchronous
native-command replay have been removed: a command invocation was not proof of a
local user gesture, and classification could race the later native clipboard read.
Plain text now stays entirely in native Tern input. Native text-field paste already
bypassed that override; removing it does not create a universal clipboard barrier.
The remote execution RPC exposes native tools and context disposal, not clipboard
capture. There is no clipboard reader, clipboard URI, watcher, or automatic sync
product feature. Separately authorized Bash/Eval retains its broad account authority.
Path-looking plain text is not interpreted by the bridge as a file upload.

The originating device and destination conversation/draft are fixed independently
of the agent binding. Sources are private snapshots of selected regular files.
Uploads use bounded chunks, ownership checks, byte counts, SHA-256 verification,
and atomic publication before becoming eligible for handoff. The extension
validates the destination again and appends quoted real remote paths with one
synchronous editor update, preserving the latest draft text and leaving it unsent.
Files may contain hostile instructions; transferring them does not authorize
executing their contents.

**The bridge rejects images on its own human-transfer path.** Recognized image
selections are rejected before bridge upload or editor mutation; the draft side
also rejects image attachments. These checks do not disable native Tern paste
routes: a bypass was observed in a same-Mac remote-loopback fixture. Do not treat
bridge rejection as a universal clipboard barrier or proof about actual remote
server uploads. Atomic original-draft confirmation remains unavailable on the
reviewed native image interface. Do not rename images to bypass detection.
Native image reads and screenshots remain separate, supported tool-result paths
subject to their permissions.

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
