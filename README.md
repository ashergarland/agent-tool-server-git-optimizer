# Agent Tool Server Git Optimizer

Read-only, bounded Git change orientation for coding agents, implemented as a thin
[`@agent-tool-platform/runtime`](https://github.com/ashergarland/agent-tool-platform/tree/98ec8162fb11d5c04aee9e6f7b3625a472a0180d/packages/runtime)
capability.

It answers one question well: **what changed between two existing commits, and which files are
worth inspecting next?** The name is historical; this capability summarizes changes and never
optimizes or mutates a repository.

## Tool behavior

### `summarize_commit_diff`

Supported comparisons:

- a target commit against its first parent;
- two existing branch, tag, or commit references;
- a proven root commit against Git's empty tree.

| Input            | Required | Default      | Purpose                                        |
| ---------------- | -------- | ------------ | ---------------------------------------------- |
| `repositoryPath` | No       | `.`          | Repository confined beneath an allowed root    |
| `baseRef`        | No       | first parent | Base commit-ish                                |
| `targetRef`      | No       | `HEAD`       | Target commit-ish                              |
| `maxFiles`       | No       | server limit | Upper bound on returned reviewable files       |
| `whitespace`     | No       | `preserve`   | `preserve` or trailing-space-only `ignore-eol` |

The result contains effective commit IDs, changed paths, exact line counts, binary flags, bounded
details, and best-effort changed symbols, configuration keys, and routes. It filters known
lockfiles and generated assets, while returning explicit ignored counts and warnings.

It does not inspect working-tree changes, return a full patch, read arbitrary source, clone, fetch,
commit, merge, rebase, push, or accept caller-selected Git argv.

## Routing seam

Use Git Optimizer before AST, Data Cruncher, or raw-source reads when the first question is which
files changed between two refs. Its source-level signals identify the smallest useful follow-up:

- AST for declaration and dependency structure in selected files;
- Data Cruncher for aggregation across multiple structured Git summaries;
- raw source or a full-diff reader when literal values or exact implementation are required.

The agent owns orchestration. Git Optimizer invokes no other capability.

An absent file is evidence of no change only when the effective refs are correct, `truncated` is
false, and warnings or filtered-path accounting do not qualify the conclusion.

## Run the capability

Node.js 22 and Git 2.34 or newer are required.

```bash
npm ci
npm run build
npm run mcp:stdio
```

The stdio entrypoint enables the launch directory as the implicit repository root when
`GIT_ALLOWED_ROOTS` is absent. With explicit roots, relative repository paths resolve from the
first root unless `GIT_LOCAL_PATHS_ENABLED=true` is deliberately set.

Example MCP configuration:

```json
{
  "servers": {
    "git-optimizer": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/agent-tool-server-git-optimizer/dist/stdio.js"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

The package binds no network listener and needs no cloud infrastructure or provider credentials.

## Repository boundary

For every invocation:

1. caller input is resolved against the configured base and checked lexically against an allowed
   root;
2. Platform `RootBoundary` canonicalizes the root and candidate, rejecting traversal and symlink
   escapes;
3. Git reports the canonical working-tree top level or explicitly addressed bare repository;
4. the working tree, Git directory, primary object directory, every recursively declared alternate
   object directory, and Git-resolved top level are each checked against the allowed roots.

Only existing repositories are accepted. Returned file names are repository-relative and bounded.
Linked worktrees and submodules are accepted only when their separate Git metadata/object storage
is also beneath an explicitly allowed root. Valid alternate paths follow Git's relative and
C-quoted path semantics; malformed or unresolvable entries fail closed even where Git would only
warn. Admission rejects graphs exceeding six alternate links, 128 object databases, 256 entries,
1,024 resolved path components, or 64 KiB per `info/alternates` file.

## Git isolation

Platform owns process mechanics, cancellation, output ceilings, and lifecycle scratch. Git
Optimizer owns only the Git-specific executable and argv policy.

Each application receives a private scratch workspace used for `HOME`, `USERPROFILE` on Windows,
all temporary-directory variables, and isolated global/system Git config paths. Git receives a
minimal allowlisted environment rather than the application's ambient environment.

Every command uses a resolved absolute executable with `shell: false`, bounded argv/output/time,
and fixed protections including:

- `--no-pager`, `--literal-pathspecs`, `--no-optional-locks`;
- `--no-ext-diff`, `--no-textconv`, `--end-of-options`, and `--` at domain boundaries;
- disabled hooks, external diff, text conversion, filesystem monitors, editors, askpass,
  credential helpers, maintenance, and network protocols;
- no system/user Git configuration, prompting, tokens, proxies, or ambient credentials.

Closing the application drains bounded Git work and Platform removes only its owned scratch.
Repositories are never lifecycle-owned and are never modified.

## Configuration

See [`.env.example`](.env.example) and
[`schemas/local-configuration.schema.json`](schemas/local-configuration.schema.json).

| Variable                            | Default   | Purpose                                     |
| ----------------------------------- | --------- | ------------------------------------------- |
| `GIT_ALLOWED_ROOTS`                 | empty     | Absolute repository roots                   |
| `GIT_LOCAL_PATHS_ENABLED`           | `false`   | Allow launch-directory access               |
| `GIT_EXECUTABLE`                    | PATH      | Absolute trusted Git override               |
| `GIT_TRUST_REPOSITORY_OWNERSHIP`    | `false`   | Opt into `safe.directory=*`                 |
| `GIT_CONCURRENCY`/`GIT_QUEUE_LIMIT` | `4`/`32`  | Bounded work and backpressure               |
| `GIT_TIMEOUT_MS`                    | `20000`   | Per-command wall-clock limit                |
| `GIT_MAX_FILES`                     | `200`     | Returned-file ceiling                       |
| `GIT_MAX_BUFFER_BYTES`              | `8388608` | Captured Git-output ceiling                 |
| `GIT_MAX_PATCH_BYTES`               | `2097152` | Best-effort signal-extraction patch ceiling |

## Profile

[`capability-profiles.json`](capability-profiles.json) declares the exact Platform v1 profile:

```text
execution=local
delivery=package
access=local-process
workload=filesystem
provider=none
mutation=read-only
```

See [`docs/deployment-profiles.md`](docs/deployment-profiles.md) for the ownership boundary.

## Validation

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit
npm run metadata:validate
npm run package:smoke
npm audit --omit=dev --audit-level=high
```

Deployment-contract validation uses the exact reviewed Platform source revision rather than a
copied schema:

```bash
AGENT_TOOL_PLATFORM_CHECKOUT=/path/to/platform npm run deployment:validate
AGENT_TOOL_PLATFORM_CHECKOUT=/path/to/platform npm run deployment:conformance
```

## License

MIT
