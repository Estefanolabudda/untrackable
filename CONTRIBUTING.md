# Contributing

Thanks for helping make the web a little less trackable.

## Principles

Every change must respect the product principles: privacy by default, zero
friction, functionality first, local only, transparency, user control,
minimal permissions. In doubt, **leave a URL unchanged** rather than risk
breaking it.

## Workflow

1. Fork and create a branch.
2. Read [`docs/development.md`](docs/development.md) and the
   [engine specification](docs/architecture/engine-spec.md).
3. Make the change with tests:
   - new tracker → `rules/rules.json` + fixtures in `tests/fixtures/cases.json`
     (include a case proving functional parameters survive),
   - engine change → spec + **both** engines + fixtures,
   - extension change → unit or e2e test.
4. Run `npm run check`, `cargo test --all` and `npm run test:e2e`.
5. Open a pull request describing what changes for users.

## Adding tracking parameters

Only add a parameter if it is demonstrably used for tracking and never needed
for a site to work. Use synthetic URLs in fixtures – never real tokens or
personal links. Put parameters that some sites use functionally into a
`strict` rule or a domain-specific rule.

## Dependencies

New dependencies need a justification (necessity, maintenance status,
licence). The extension bundle must not gain runtime dependencies without
discussion.
