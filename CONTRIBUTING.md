# Contributing

Short version: no build step, no dependencies, and it has to keep working under
a strict CSP.

## Before you open a pull request

```sh
node --test 'tests/**/*.test.mjs'
node tools/validate-config.mjs examples/config/*.yaml
kubectl kustomize .
helm lint deploy/helm/quickportal
```

CI runs the same things, plus a schema check on the rendered manifests and a
size check on `src/`.

## Rules that are not negotiable

- **No runtime dependencies and no build step.** No `package.json`, no bundler,
  no framework, no CDN link. The app is mounted from a ConfigMap, so what is in
  `src/` is what runs.
- **Nothing inline.** No inline `<script>`, no `style=` attribute, no `onclick=`
  or other inline handler, no `eval`, no `new Function`. The page is served
  under `script-src 'self'; style-src 'self'` and inline anything silently
  breaks it in production. Set CSS custom properties through the CSSOM
  (`element.style.setProperty`) rather than writing a style attribute.
- **Basenames under `src/` must stay unique.** A ConfigMap key cannot contain a
  slash, so the served tree is flat and two files called `utils.js` would
  collide. Imports are flat relative paths (`./config.js`).
- **Only placeholder hostnames.** `example.com`, `example.org`, and
  `203.0.113.0/24` for addresses. No real host, user or path in code, comments,
  examples, tests or commit messages.
- **Adding a third-party file** means vendoring it unminified at a pinned
  version and recording its licence and SHA-256 in `THIRD-PARTY.md`. It must not
  need `eval` or `new Function`.

## Changing the config schema

The schema is a contract with other people's clusters. A new optional key with
a documented default is fine. Renaming or removing one is breaking and needs a
`version` bump plus a migration note. Update `docs/CONFIGURATION.md` in the same
pull request, and add a test to `tests/config.test.mjs`.

## Tests

`node:test` only, no test framework. Modules must import cleanly in plain Node
with no DOM, which is why browser things (`window.open`, `fetch`, `document`,
`localStorage`) are taken as an injectable trailing argument.

Note `node --test tests/` does not work on Node 25: it treats the directory as a
module entry point. Use the glob.
