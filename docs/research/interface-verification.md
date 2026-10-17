# Interface verification

These observations inform the specification; they are not an implemented bridge
or a substitute for end-to-end acceptance. Experiments used isolated temporary
configurations and synthetic content, without submitting a model prompt, reading
the person's clipboard, or operating a real desktop or Android device.

## Environments and results

| Check | Environment | Observed result |
|---|---|---|
| Paste command override | Installed Tern 0.8.3, macOS | The registered override consumed the Paste command. |
| Bracketed input transport | Installed Tern 0.8.3, local pane | A frame containing ESC bytes and a Unicode image path arrived byte-for-byte: 37 of 37 bytes. |
| Remote pane input transport | Installed Tern 0.8.3, remote loopback pane | The same frame arrived byte-for-byte. This was not a public-network bridge test. |
| Draft image insertion | Installed OMP 18.10.4-1.1.61, isolated interactive session | Public `pasteToEditor` attached a staged synthetic image, retained the draft, and left the session idle. |
| Attachment content and negative control | Available OMP 18.10.1 source, real editor/controller implementation | Bracketed image-path paste and `pasteToEditor` stored the PNG content. Direct `pasteText` inserted text without attaching an image. |
| Same-name Eval wrapper | Installed OMP 18.10.4-1.1.61 and its real extension loader/native Eval | JS and Python computer facades could be installed while retaining ordinary state; subsequent calls and explicit reset passed. |
| Hook availability | Installed Tern 0.8.3 | `tern.on("paste")` reported an unknown event; overriding `edit.paste` reported an unknown command; direct `agents.attach` and `session.paste` methods were absent. |

Machine-readable, redacted observations are in
[interface-verification.json](interface-verification.json).

## What this does not prove

- The hook checks do **not** prove that standard Cmd/Ctrl+V cannot be implemented
  using available interfaces. Its actual native editing states still require
  targeted testing. Standard paste has not been downgraded to a dedicated key.
- The facade experiment used a clearly synthetic capabilities response. It did
  not perform real remote computer operations or validate the full approval,
  handle, screenshot, and cancellation lifecycle.
- No browser-use bridge was exercised. Browser backends differ in capabilities;
  client execution must use the selected device's backend and report unsupported
  operations rather than silently changing devices or profiles.
- No Windows-native client bridge was exercised. A macOS run, a loopback route,
  or the older source harness is not Windows acceptance evidence.
- The initial temporary probes were removed after their observations were captured;
  they were not a runnable regression suite. Later implementation and acceptance
  evidence is tracked in [Compatibility](../compatibility.md).

## Reusable interfaces and design limits

Same-name OMP tool extensions can delegate ordinary targets to the native tool via
`ctx.invokeTool`. A selected client Eval can use a device-local runtime; a facade
adapter is another verified integration seam where needed. Neither approach
makes local approval, transport integrity, or session cleanup automatic.

The existing SSH URI implementation is a useful routing precedent, not the full
client filesystem backend: its published handler is UTF-8/POSIX-oriented and
limits text reads. Client image and Windows file support need the actual client
resource adapter, not a claim that an SSH text handler is a general file service.

An agent-host process cannot identify which of several Tern clients initiated a
binding action by examining the shared server account. Local UI origin and OMP
session identity must be associated explicitly. A shared root account is also
not a per-person security boundary.

## Follow-up: native pane identifiers

A read-only Tern 0.8.4 WindowCx probe connected to an actual Linux Tern 0.8.3
service. Its 58 exposed Lua pane aliases were distinct and within the exact
integer range; numeric lookup and `@focused` resolved the same current pane.
The controller's diagnostic JSON used a different, larger identifier namespace.
Converting those diagnostic IDs to floating-point numbers does not demonstrate
precision loss in the plugin's Lua identifiers. This probe sent no remote input
and does not establish native paste or remote file-upload acceptance.

## Primary sources

- [Tern plugin architecture](https://docs.stencil.so/tern/concepts/architecture.md)
- [Tern commands and overrides](https://docs.stencil.so/tern/guides/commands.md)
- [Tern window interfaces](https://docs.stencil.so/tern/reference/api-window.md)
- [Tern program input protocol](https://docs.stencil.so/tern/protocol/input.md)
- [OMP image input controller, inspected revision](https://github.com/can1357/oh-my-pi/blob/d7383294/packages/coding-agent/src/modes/controllers/input-controller.ts)
- [OMP enhanced-paste state machine, inspected revision](https://github.com/can1357/oh-my-pi/blob/d7383294/packages/coding-agent/src/utils/enhanced-paste.ts)
- [OMP computer facade/controller seam](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/tools/computer.ts)
- [OMP internal URL router](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/internal-urls/router.ts)
- [OMP SSH file transfer implementation](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/ssh/file-transfer.ts)
- [OpenSSH reverse forwarding](https://man.openbsd.org/ssh.1#R)
