# Contributing

Use Node.js 22 and install with `npm ci`.

Keep provider logic out of transports, external SDK types out of services, and every exposed tool
in the shared typed registry. New write tools must support dry-run and explicit confirmation.
Tests must cover validation, safe errors, guardrails, and generated transport surfaces.

Before opening a pull request, run the complete validation list in `README.md`. Never commit `.env`
files, deployment outputs, credentials, tenant/subscription identifiers, or generated secrets.
