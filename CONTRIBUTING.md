# Contributing to ts-architecture-template

Thank you for contributing to this contract-first TypeScript architecture template.

## Scope

This repository is implementation-first and focuses on a reusable scaffold for:

- Gateway, engine, memory, and auth component boundaries
- OpenAPI/JSON Schema contract alignment
- Conformance and lock-in guardrails
- Local onboarding and acceptance flows

## How to Contribute

1. Fork the repository.
2. Create a branch from `main`.
3. Make focused, minimal changes tied to one purpose.
4. Run the project checks locally.
5. Open a pull request with a clear summary and rationale.

## Local Validation Checklist

Run these before opening a PR:

```bash
npm ci
npm run check
npm run check:conformance
npm run acceptance:check
```

If your change affects runtime behavior, include notes on expected behavior changes and test coverage in the PR description.

## Pull Request Guidance

- Keep changes small and reviewable.
- Prefer config-driven behavior over hard-coded provider logic.
- Preserve public gateway request/response shape unless intentionally versioning contracts.
- Update docs/tests alongside behavior changes.

For major architecture or contract changes, open an issue first to align on scope.

## Discussion and Feedback

- Issues: https://github.com/Personal-AI-Architecture/ts-architecture-template/issues
- Forum: https://community.braindrive.ai/c/personal-ai-architecture/39

## License

By contributing, you agree your contributions are licensed under the repository MIT License.
