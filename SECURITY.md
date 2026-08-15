# Security

## Reporting

Report vulnerabilities privately through GitHub Security Advisories for this repository. Do not
open a public issue for an undisclosed vulnerability.

## Threat model

The server is read-only. It runs Git against repositories that already exist on the host and
returns bounded summaries. It never mutates a repository, never reaches the network, and never
holds repository credentials.

### Assets

- the host filesystem outside the configured repository roots
- the contents of repositories the caller was not authorized to reach
- the process environment, including any credentials present on the host
- availability of the tool server itself

### Trust boundaries

| Boundary                       | Assumption                                           |
| ------------------------------ | ---------------------------------------------------- |
| Tool caller (agent or client)  | Untrusted. Every input is validated and confined.    |
| Repository contents and config | Untrusted. A repository may be attacker-authored.    |
| Repository roots               | Trusted to be the set an operator intends to expose. |
| Host operator configuration    | Trusted.                                             |

### Threats and mitigations

| Threat                                                                                    | Mitigation                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path traversal or symlink escape to read another repository                               | Lexical containment before filesystem access, `realpath` on roots and candidate, and re-checking the canonical Git top level.                                                                            |
| Git walking upward into a parent repository                                               | The resolved top level must itself lie beneath an allowed root.                                                                                                                                          |
| Argument injection through a reference or filename                                        | Reference syntax validation, resolution to object IDs, `--end-of-options`, `--literal-pathspecs`, `--` before pathspecs, and NUL-delimited parsing. Paths Git would quote are never reused as pathspecs. |
| Repository-controlled code execution via `diff.external`, `textconv`, or `core.fsmonitor` | `--no-ext-diff` and `--no-textconv` on every diff, and `diff.external`, `core.fsmonitor`, `core.pager`, `core.editor`, `core.sshCommand`, and `credential.helper` pinned by `-c`.                        |
| Credential theft through prompting or helpers                                             | Scrubbed environment with `GIT_TERMINAL_PROMPT=0`, empty askpass, no inherited tokens or proxies, isolated `HOME`, and disabled system and global configuration.                                         |
| Shell metacharacter injection                                                             | Git is executed with `execFile` and `shell: false`; no command string is ever constructed.                                                                                                               |
| Writes to a repository the operator mounted read-only                                     | Read-only tooling, `GIT_OPTIONAL_LOCKS=0`, `--no-optional-locks`, `gc.auto=0`, and `maintenance.auto=false`.                                                                                             |
| Resource exhaustion from a hostile or enormous repository                                 | Per-command timeouts, abort on disconnect, bounded stdout and argument size, a bounded worker queue that returns a retryable `busy` error, and capped result sizes.                                      |
| Information disclosure through errors or logs                                             | One typed error model with bounded details; raw stderr, absolute paths, environment values, and repository configuration are never returned or logged.                                                   |
| Credential brute force against the HTTP transport                                         | Fixed-width keyed HMAC digests compared in constant time, per-principal rate limiting, and pre-auth rate limiting by client address.                                                                     |
| Silent under-reporting of a change set                                                    | `totalFiles`, `returnedFiles`, `truncated`, `ignoredFiles`, and `warnings` are always returned.                                                                                                          |

### Out of scope

The server does not authenticate to Git remotes, clone, fetch, or synchronize repositories.
Operators must place repositories on the host, or mount them read-only, using their own secure
process. Hosted deployments must not embed keys or repositories in container images.

## Deployment requirements

Deployments must enable authentication, store credentials in a secret manager, use least-privilege
provider roles, mount repositories read-only, keep the root filesystem read-only with explicit
writable temporary space, and review dependency and container findings before release.
