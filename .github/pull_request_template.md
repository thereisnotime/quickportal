## What this changes

## Why

## Checks

- [ ] `node --test 'tests/**/*.test.mjs'` passes
- [ ] `kubectl kustomize .` renders
- [ ] `node tools/validate-config.mjs examples/config/*.yaml` passes
- [ ] No inline script, style attribute or inline handler added
- [ ] No runtime dependency, no build step, no `package.json` added
- [ ] Only placeholder hostnames in code, comments, examples and tests
- [ ] `docs/CONFIGURATION.md` updated if the schema changed
