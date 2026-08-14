# Agent Tool Server Git Optimizer

Local Git history and diff analysis for ChatGPT Actions, VS Code MCP clients, and GitHub Copilot
CLI. The server exposes one typed tool through stdio MCP, Streamable HTTP MCP, and HTTP/OpenAPI.

## Tool

### `summarize_commit_diff`

Runs `git diff` in a local repository and returns a compact per-file changelog. It removes:

- `package-lock.json` and `pnpm-lock.yaml`
- files under generated-output directories such as `dist`, `build`, `coverage`, and `generated`
- minified files, source maps, images, fonts, and other generated assets
- whitespace-only changes

Input:

| Field            | Required | Default | Purpose                    |
| ---------------- | -------- | ------- | -------------------------- |
| `repositoryPath` | No       | `.`     | Local Git working tree     |
| `baseRef`        | No       | parent  | Base commit or ref         |
| `targetRef`      | No       | `HEAD`  | Commit or ref to summarize |

When `baseRef` is omitted, the tool compares the parent of `targetRef`; root commits are compared
with Git's empty tree.

## Run locally

Node.js 22 and Git are required.

```bash
npm ci
cp .env.example .env
npm run build
npm run mcp:stdio
```

For HTTP development:

```bash
npm run dev
```

The default development configuration disables authentication. Production requires API-key
authentication; see `.env.example` and [`docs/deployment.md`](docs/deployment.md).

## Endpoints

| Method            | Path                | Authentication |
| ----------------- | ------------------- | -------------- |
| `GET`             | `/health`           | Public         |
| `GET`             | `/version`          | Public         |
| `GET`             | `/openapi.json`     | Public         |
| `GET`             | `/tools`            | Required       |
| `POST`            | `/tools/{toolName}` | Required       |
| `GET/POST/DELETE` | `/mcp`              | Required       |

## Validation

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run metadata:validate
```

## License

MIT
