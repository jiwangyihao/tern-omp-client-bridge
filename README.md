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
- Plain text uses native Tern paste unchanged: no bridge override, clipboard
  read/classification, asynchronous preflight, or replay. Native file/bitmap paste
  and fail-closed image rejection across all native routes remain blocked gates.
- Bridge-managed ordinary-file transfers originate on **this device**,
  independently of the agent binding, and append quoted real agent-host file
  paths to the original unsent draft. They do not submit a prompt.
- **The bridge rejects human images on its own transfer path.** Native paste
  routes can bypass that path; end-to-end image rejection remains incomplete.
  Same-Mac loopback observations do not establish actual remote-server upload.
  Image file reads and browser/computer screenshot results remain supported.
  No OMP host patch is used.
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
The approved image-scope reduction requires fail-closed rejection instead of
image-paste success; enforcing that requirement at every native entry remains open.
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
