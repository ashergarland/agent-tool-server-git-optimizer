# Contributing

Use Node.js 22 and install with `npm ci`.

Keep Git-specific policy in domain services and generic lifecycle, transport, registry, process,
filesystem, and error mechanics in Agent Tool Platform. This capability is read-only: do not add
tools that mutate a repository, clone or fetch, run arbitrary Git commands, or read arbitrary
files.

Tests must cover input validation, safe errors, repository confinement, Git isolation, output
bounds, routing guidance, Platform conformance, and package execution outside the checkout. Prefer
real temporary repositories over mocks; tests must not need network access or credentials.

Before opening a pull request, run the complete validation list in `README.md`. Never commit `.env`
files, credentials, provider identifiers, or generated secrets.
