# Tern / OMP Client Bridge

Use a manually selected client device's files and execution capabilities from a
remote OMP session, without replacing Tern's native OMP GUI. A companion process
on each client connects **outbound over SSH** to an agent-host relay. It runs native
OMP tools, not another reasoning agent.

## Status and scope

This repository contains the broker, outbound client, native OMP extension, Tern
plugin, and finite installation commands. macOS and native Windows are client
targets; implementation is not the same as completed platform acceptance. Read
[Compatibility and evidence boundaries](docs/compatibility.md) before deployment.
In particular, same-machine integration coverage does not establish three-device,
Windows GUI, native paste/drop, desktop, or attached-Android acceptance.

- Each OMP session starts unbound. Humans select its shared target; all viewers
  see the binding, switch actor, and online/offline status. Switching changes the
  next invocation, not a running operation.
- Existing `eval` and `bash` accept `target: "client"`; the agent host remains the
  default. Existing file tools use `client:///absolute/path` on the bound device.
- Client JS/Python, shell, browser, desktop, and ADB usage retain their native
  prerequisites, permissions, and device/context ownership. These are not
  interchangeable backends or a sandbox for arbitrary execution.
- Native text/image paste remains unchanged: no bridge override, asynchronous
  classification or replay. Native input does not need bridge validation.
- **OMP: Paste image to remote** is an explicit local command/status action.
  After local confirmation, one clipboard image is snapshotted and uploaded;
  native Cmd/Ctrl+V remains untouched. No agent clipboard tool or watcher is added.
- Local file drops originate on **this device**, independently of agent binding.
  Uploaded images enter OMP's native image-paste handling. Ordinary files become
  quoted paths into a private temporary inbox, with a README, draft reminder and
  user notice to archive/copy them into project storage before working on them.
  Existing drafts remain unsent; referenced uploads are not automatically deleted.
- PNG/JPEG/GIF/WebP image paths use native attachment handling. Native preview
  completion remains the host's responsibility. No OMP host patch is used.
- Disconnects never select another device or replay a side-effecting operation.

## Start here

Install Bun **1.4.3 or newer** and this checkout with its pinned dependencies on
both the agent host and each client. The bridge uses OMP SDK **18.10.4**. From the
checkout on each machine:

```sh
bun install --frozen-lockfile --ignore-scripts
bun src/cli.ts --help
```

Then follow [Setup and usage](docs/usage.md) for the complete two-machine sequence:
install the OMP loader on the agent host, run its broker, install the Tern plugin
on the client, and start the client with an explicit capability grant and SSH
relay command. The installers do **not** start services or reload applications.
Keep the checkout installed: the OMP loader refers to its source entrypoint.

Read [Security](docs/security.md) before granting access. A shared server account
or root is not per-person isolation. `files` and `exec` are coarse grants, and
separately authorized code can access the OS account's resources.

## Specification and repository

The product specification is
[Issue #1: Native Tern client bridge for OMP](https://github.com/jiwangyihao/tern-omp-client-bridge/issues/1).
The latest approved scope preserves native paste and permits an explicit image
command, image/file drops, and ordinary-file inboxes with archival guidance.
Implementation work is tracked in
[GitHub Issues](https://github.com/jiwangyihao/tern-omp-client-bridge/issues).
Source: [tern-omp-client-bridge](https://github.com/jiwangyihao/tern-omp-client-bridge).

## Reading map

- [Setup and usage](docs/usage.md)
- [Security and trust boundaries](docs/security.md)
- [Compatibility and evidence boundaries](docs/compatibility.md)
- [Verification record and open acceptance gates](docs/verification.md)
- [Domain glossary](CONTEXT.md)
- [Architecture decisions](docs/adr/)
- [Interface research and limits](docs/research/interface-verification.md)
- [Agent workflow](AGENTS.md)

## License

[Mozilla Public License 2.0](LICENSE), SPDX identifier `MPL-2.0`.
