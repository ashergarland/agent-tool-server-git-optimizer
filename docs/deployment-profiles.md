# Deployment profiles

The canonical public declaration is [`../capability-profiles.json`](../capability-profiles.json).
It uses Agent Tool Platform deployment contract v1 at revision
`98ec8162fb11d5c04aee9e6f7b3625a472a0180d`.

## Local package profile

Git Optimizer declares one `local-package` profile:

| Dimension | Value           | Reason                                                         |
| --------- | --------------- | -------------------------------------------------------------- |
| execution | `local`         | Git and the capability run on the invoking machine.            |
| delivery  | `package`       | npm supplies the built stdio executable.                       |
| access    | `local-process` | The agent host owns the stdio process and pipe.                |
| workload  | `filesystem`    | Existing repositories are read beneath explicitly bound roots. |
| provider  | `none`          | No cloud or external provider is required.                     |
| mutation  | `read-only`     | The only exposed operation compares existing commits.          |

The workload boundary is the launch directory by default or `GIT_ALLOWED_ROOTS` when configured.
Repositories and their credentials remain outside capability ownership. Platform-owned scratch is
private process-local state and is removed at shutdown.

This profile needs no HTTP listener, container, cloud account, provider credential, secret store,
operator deployment instance, or hosted control plane.

## Add another profile only when implemented

Hosted or provider-backed support must be implemented and declared as a separate profile. Do not
overload the local profile, copy Platform schemas, or reintroduce generic infrastructure here.
Provider-backed does not imply mutating; mutation requires its own explicit contract.

The full contract is maintained by
[Agent Tool Platform](https://github.com/ashergarland/agent-tool-platform/blob/98ec8162fb11d5c04aee9e6f7b3625a472a0180d/docs/deployment-contracts.md).
