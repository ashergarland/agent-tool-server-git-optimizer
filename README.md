# Agent Tool Server Git Optimizer

Read-only Git diff summarization for coding agents. The server exposes one typed tool through
stdio MCP, Streamable HTTP MCP, and HTTP/OpenAPI, all driven by a single validated tool registry.

It answers one question well: **what changed between two commits, and which files are worth
reading?** It is designed to be called before an agent asks for a full patch.

## What it does and does not do

Supported comparisons:

- a commit against its first parent (`targetRef` alone)
- any two commit-ish references that already exist in the repository (`baseRef` and `targetRef`)
- a root commit against Git's empty tree, only after proving the commit has no parent

Non-goals, by design:

- no uncommitted or staged working-tree analysis
- no file reading, searching, or writing
- no commits, merges, rebases, pushes, fetches, clones, or repository maintenance
- no arbitrary Git commands, credentials, remotes, or uploads
- no full patch output

The name is historical. The capability is diff summarization, not repository optimization.

## Tool

### `summarize_commit_diff`

| Input            | Required | Default      | Purpose                                         |
| ---------------- | -------- | ------------ | ----------------------------------------------- |
| `repositoryPath` | No       | `.`          | Local repository, confined to a configured root |
| `baseRef`        | No       | first parent | Base commit-ish                                 |
| `targetRef`      | No       | `HEAD`       | Commit-ish to summarize                         |
| `maxFiles`       | No       | server limit | Upper bound on returned files                   |
| `whitespace`     | No       | `preserve`   | `preserve` or `ignore-eol`                      |

| Output                                     | Meaning                                             |
| ------------------------------------------ | --------------------------------------------------- |
| `summary`                                  | Bounded one-line-per-file changelog                 |
| `files[]`                                  | Path, change kind, line counts, binary flag, detail |
| `ignoredFiles[]`, `ignoredFileCount`       | Filtered noise; **these were not reviewed**         |
| `totalFiles`, `returnedFiles`, `truncated` | Honest coverage accounting                          |
| `warnings[]`                               | Why anything was filtered, skipped, or bounded      |
| `baseCommit`, `targetCommit`               | Effective object IDs actually compared              |

Whitespace handling is explicit. `preserve` is the default and reports every whitespace change,
including semantic indentation in Python, YAML, and Makefiles. `ignore-eol` ignores **only**
trailing end-of-line whitespace differences; nothing else is suppressed.

Filtering removes lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`,
`bun.lockb`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `go.sum`, and peers), `node_modules`, and
generated assets such as source maps, minified bundles, images, and fonts. Ambiguous directory
names like `dist`, `build`, or `coverage` are **not** filtered by default because they hold real
source in many projects; add them with `GIT_EXTRA_IGNORED_DIRECTORIES` when they do not.

Symbol names come from Git hunk headers. They are advisory context, not a complete list of
changed definitions.

## Local use is the primary mode

Node.js 22 and Git 2.34 or newer are required.

```bash
npm ci
cp .env.example .env
npm run build
npm run mcp:stdio
```

Run it from the workspace you want to analyze. The stdio entrypoint enables
`GIT_LOCAL_PATHS_ENABLED`, so the launch directory becomes the implicit repository root. Set
`GIT_ALLOWED_ROOTS` to narrow it further.

### VS Code and other MCP clients

```json
{
  "servers": {
    "git-optimizer": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/agent-tool-server-git-optimizer/dist/mcp/stdio.js"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

### HTTP development

```bash
npm run dev
```

The default development configuration disables authentication and configures no repository root,
so `/ready` reports `not-ready` until you set `GIT_ALLOWED_ROOTS` or `GIT_LOCAL_PATHS_ENABLED`.

## Repository boundary

Every call resolves the caller's path this way:

1. resolve it against the configured base directory and reject anything outside a root lexically,
   before touching the filesystem;
2. `realpath` both the roots and the candidate, rejecting symlinks that escape;
3. ask Git for the canonical top level, or the git directory for an explicitly supported bare
   repository;
4. re-check that canonical path against the roots, so Git cannot walk upwards past one.

Git then runs from that canonical path and every returned path is repository-relative.

## Git isolation

Git is invoked directly, never through a shell, from a resolved absolute executable, with a
scrubbed environment and configuration that a repository cannot influence:

- `--no-ext-diff`, `--no-textconv`, `--literal-pathspecs`, `--no-optional-locks`, `--no-pager`
- `--end-of-options` before caller-supplied references and `--` before pathspecs
- `diff.external`, `core.fsmonitor`, `core.pager`, `core.editor`, `core.askPass`,
  `core.sshCommand`, `credential.helper`, `gc.auto`, and `maintenance.auto` pinned to safe values
- `GIT_CONFIG_NOSYSTEM`, isolated `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, isolated `HOME`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, and no inherited tokens, proxies, or helpers
- per-command timeouts, abort signals, bounded stdout, bounded argument size, and a worker
  semaphore with a queue that returns a retryable `busy` error instead of piling up

Mounted repositories should be read-only. The server never creates locks or writes to a
repository. Errors are normalized into typed responses; raw stderr, absolute paths, environment
details, and repository configuration are never returned or logged.

## Endpoints

| Method            | Path                | Authentication | Purpose                               |
| ----------------- | ------------------- | -------------- | ------------------------------------- |
| `GET`             | `/health`           | Public         | Liveness only                         |
| `GET`             | `/ready`            | Public         | Git, temp space, and repository roots |
| `GET`             | `/version`          | Public         | Build, Git version, capabilities      |
| `GET`             | `/openapi.json`     | Public         | Generated OpenAPI 3.1 document        |
| `GET`             | `/tools`            | Required       | Tool catalogue and JSON Schemas       |
| `POST`            | `/tools/{toolName}` | Required       | Tool invocation                       |
| `GET/POST/DELETE` | `/mcp`              | Required       | Stateless Streamable HTTP MCP         |

Every transport returns the same error body: `code`, `message`, `retryable`, `requestId`, and
bounded `details`.

## Configuration

See [`.env.example`](.env.example) for the full list. The settings that matter most:

| Variable                            | Default  | Purpose                                                |
| ----------------------------------- | -------- | ------------------------------------------------------ |
| `GIT_ALLOWED_ROOTS`                 | empty    | Absolute roots; **required in production**             |
| `GIT_LOCAL_PATHS_ENABLED`           | `false`  | Implicit launch-directory root; rejected in production |
| `GIT_TRUST_REPOSITORY_OWNERSHIP`    | `false`  | Needed when a mount is owned by another user           |
| `GIT_CONCURRENCY`/`GIT_QUEUE_LIMIT` | `4`/`32` | Git worker pool and backpressure                       |
| `GIT_TIMEOUT_MS`                    | `20000`  | Per-command time budget                                |
| `GIT_MAX_FILES`                     | `200`    | Ceiling for returned files                             |

## Deployment

Hosted operation is optional and only useful with a read-only repository mount. See
[`docs/deployment.md`](docs/deployment.md). The default Container App deploys nothing until a
repository source is supplied, because a server with no readable repository cannot serve this
tool and must not advertise itself as ready.

## Troubleshooting

| Symptom                                   | Cause and fix                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `/ready` reports `repositoryRoots` not ok | No root configured, or the mount is missing. Check `GIT_ALLOWED_ROOTS`. |
| `forbidden` on every call                 | The path resolves outside a root, or a symlink escapes one.             |
| `The repository is owned by another user` | Set `GIT_TRUST_REPOSITORY_OWNERSHIP=true` for read-only mounts.         |
| `busy` responses under load               | Raise `GIT_CONCURRENCY`, `GIT_QUEUE_LIMIT`, or replica count.           |
| `timeout` on a large repository           | Raise `GIT_TIMEOUT_MS` or narrow the comparison.                        |
| `truncated: true`                         | Expected. Raise `maxFiles` or compare a smaller range.                  |
| First hosted call is slow                 | Scale-to-zero cold start. Set `minReplicas` to 1.                       |

## Validation

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit
npm run metadata:validate
```

Tests build real temporary repositories and run the real Git executable. No network access and no
credentials are required.

## Security

See [`SECURITY.md`](SECURITY.md) for the threat model and reporting process.

## License

MIT
