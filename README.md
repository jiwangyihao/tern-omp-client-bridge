# Tern / OMP Client Bridge

A design for using client-machine capabilities from a remote OMP session while
keeping Tern's native OMP GUI. Windows and macOS clients are first-class targets.

## Status

This repository is at the specification stage. It contains the agreed domain
model, engineering conventions, decision records, and interface evidence.
Cloning it does not install a Tern plugin or a client executor.

The agreed product specification is [Issue #1: Native Tern client bridge for OMP](https://github.com/jiwangyihao/tern-omp-client-bridge/issues/1).
Subsequent implementation tickets are tracked in
[GitHub Issues](https://github.com/jiwangyihao/tern-omp-client-bridge/issues).

## Intended behavior

- Several Tern clients can connect to one remote server. Each OMP session has an
  explicitly selected client binding, synchronized to its viewers.
- Existing tools select the agent or bound client execution target. Client files
  use the `client://` namespace; ordinary agent-host behavior remains unchanged.
- Client execution covers Eval, shell commands, computer-use, browser-use, and
  ADB, with device-specific state and lifecycle handling.
- Human paste and drag/drop originate on the client where the action occurs and
  attach to the intended remote draft, independently of the agent binding.

These are requirements, not claims that the runtime has already been shipped.

## Reading map

- [Domain glossary](CONTEXT.md)
- [Architecture decisions](docs/adr/)
- [Interface verification and limits](docs/research/interface-verification.md)
- [Agent workflow](AGENTS.md)

## License

[Mozilla Public License 2.0](LICENSE), SPDX identifier `MPL-2.0`.
