# Security

## Reporting

Report vulnerabilities privately through GitHub Security Advisories for this repository. Do not
open a public issue for an undisclosed vulnerability.

## Threat model

The capability runs read-only Git comparisons against repositories already present on the local
host. The caller, repository contents, filenames, attributes, and repository configuration are
untrusted. Explicit repository roots and the invoking user's filesystem permissions form the
authorization boundary.

### Threats and mitigations

| Threat                                         | Mitigation                                                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Traversal, symlink, or alternate-object escape | Lexical containment plus canonical validation of the working tree, Git directory, primary and recursively declared alternate object directories, and resolved top level.   |
| Ref or argv injection                          | Restricted ref grammar, commit-object resolution, fixed argv, `--end-of-options`, literal pathspecs, and NUL-delimited parsers.                                            |
| Repository-controlled execution                | External diffs, text conversion, hooks, filesystem monitors, editors, askpass, SSH commands, credential helpers, and maintenance are disabled.                             |
| Ambient credential or config exposure          | Platform builds a minimal child environment. Private lifecycle scratch supplies `HOME`, temporary directories, and global/system Git config paths.                         |
| Shell injection                                | Platform spawns the resolved absolute Git executable with `shell: false`; the agent cannot provide a command or argv.                                                      |
| Repository mutation                            | The only tool compares commits; optional locks, maintenance, garbage collection, and protocols are disabled. Mount permissions remain an operator defense in depth.        |
| Resource exhaustion                            | Platform process time/output/cancellation bounds, a bounded queue, argument ceilings, bounded alternate-graph traversal, file/result ceilings, and bounded patch analysis. |
| Error disclosure                               | Platform normalizes failures; repository stderr, host paths, environment values, and process details are not returned.                                                     |
| Silent under-reporting                         | Effective refs, returned/total/ignored counts, `truncated`, and warnings are always returned.                                                                              |

## Non-goals

Git Optimizer never authenticates to remotes, clones, fetches, writes, commits, merges, rebases,
pushes, or exposes arbitrary Git execution. Repository contents are data, never instructions.

The supported profile is a local stdio package. It has no hosted endpoint, provider identity,
operator secret, or deployment resource.

Repository metadata is revalidated at the start of every invocation. Confinement does not make
repository metadata immutable against another local process with concurrent write access.
