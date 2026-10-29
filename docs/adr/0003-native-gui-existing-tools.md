---
status: accepted
---

# Preserve the native GUI and existing model-tool vocabulary

The user must keep Tern's native OMP GUI. Integrate through the existing tool and
input surfaces rather than replacing that GUI with a custom OMP RPC controller
or adding a parallel family of model-visible workstation tools.

Execution location is expressed by the existing execution tools' target
selection, while client filesystem location is expressed by the client URI
namespace. Plugin integration is preferred where the verified interfaces allow
it; a missing stable hook must be demonstrated before proposing a host change.

A client executor may run as a companion process. It executes native tools under
the client's native Agent policy and OS permissions; it is not an additional
reasoning agent. The plugin must not replace local policy with server settings,
force allow/deny lists, or add a second capability-grant system.
