# Contributing

Use Node.js 22 and install with `npm ci`.

Keep provider logic out of transports, external SDK types out of services, and every exposed tool
in the shared typed registry. This server is read-only: do not add tools that mutate a repository,
clone or fetch, run arbitrary Git commands, or read arbitrary files.

Tests must cover input validation, safe errors, repository confinement, Git isolation, output
bounds, routing guidance, and every generated transport surface. Prefer real temporary repositories
over mocks; tests must not need network access or credentials.

Before opening a pull request, run the complete validation list in `README.md`. Never commit `.env`
files, deployment outputs, credentials, tenant/subscription identifiers, or generated secrets.
