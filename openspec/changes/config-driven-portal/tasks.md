## 1. Repository scaffolding

- [ ] 1.1 Add `LICENSE` (MIT), `.editorconfig`, `.gitattributes` and a `.gitignore` that keeps local agent and editor tooling out of the published tree
- [ ] 1.2 Create the directory skeleton: `src/assets/`, `src/vendor/`, `deploy/kustomize/base/`, `deploy/helm/quickportal/`, `examples/`, `tools/`, `tests/`, `docs/`
- [ ] 1.3 Add a leak guard that refuses to commit real hostnames, usernames, home paths, private IP ranges or key material, so every example stays on reserved placeholder domains

## 2. Vendored YAML parser

- [ ] 2.1 Vendor the unminified ESM build of `js-yaml` at a pinned version into `src/vendor/`
- [ ] 2.2 Record upstream project, version, licence and SHA-256 of the vendored file in `THIRD-PARTY.md`
- [ ] 2.3 Confirm the parser loads as a module under a CSP of `script-src 'self'` with no inline code

## 3. Config layer

- [ ] 3.1 `src/assets/config.js`: `parseConfig` trying JSON then YAML, returning structured parse errors with line numbers
- [ ] 3.2 `normalizeConfig`: apply documented defaults, derive missing ids by slugifying within the parent path, enforce the depth cap, collect unknown-key warnings
- [ ] 3.3 Validate the schema: required `version`, refusal of an unimplemented version, duplicate id detection reporting both paths, type and URL checks, each issue carrying a `path`
- [ ] 3.4 `indexItems` and `resolveTargets`, resolving item ids, group ids (depth-first) and bare URLs, reporting unresolved targets
- [ ] 3.5 `src/assets/state.js`: theme, collapse and query persistence, every storage access wrapped so blocked storage still renders
- [ ] 3.6 Unit tests under `tests/` with `node:test` covering 3.1 to 3.5, including the minimal config, duplicate ids, future version, depth overflow and unresolved targets

## 4. Sets and live reload

- [ ] 4.1 `src/assets/sets.js`: `openSet` opening every target synchronously in the gesture, returning `{opened, blocked}`
- [ ] 4.2 Confirmation step for sets above the documented size
- [ ] 4.3 `src/assets/reload.js`: `watchConfig` polling with `If-None-Match`, hashing the body before signalling a change, pausing while hidden and firing once on becoming visible
- [ ] 4.4 Unit tests for 4.1 to 4.3 with `window.open` and `fetch` stubbed, covering blocked popups, `304`, a new ETag with identical content, and the hidden/visible transition

## 5. View layer

- [ ] 5.1 `src/index.html`: document shell with no inline script or style, a skip link and the search input
- [ ] 5.2 `src/assets/app.css`: responsive grid usable at 320px and on a wide display, light and dark via tokens, visible focus, reduced-motion support, both densities
- [ ] 5.3 `src/assets/render.js`: recursive group rendering, collapsible folders with `aria-expanded`, item cards, icon fallback to initials, set controls
- [ ] 5.4 `renderIssues`: errors block the tree, warnings are dismissible, a missing config names the path it tried
- [ ] 5.5 `applyFilter`: filter on name, description, tags and URL, expanding collapsed groups to reveal matches and restoring state when cleared
- [ ] 5.6 `src/assets/app.js`: wiring, keyboard shortcuts and the palette, theme toggle, manual reload control, re-render preserving scroll, collapse, query and focus

## 6. Deployment artifacts

- [ ] 6.1 `deploy/kustomize/base`: Deployment, Service, `configMapGenerator` over `src/`, hardened pod security context, `emptyDir` scratch, no `subPath`
- [ ] 6.2 Server config ConfigMap: revalidated config file, long-lived assets, strict CSP and the other security headers
- [ ] 6.3 A default example config ConfigMap that renders a sensible page out of the box on placeholder domains
- [ ] 6.4 `deploy/helm/quickportal`: chart with values for image, ingress, resources and inline config, `helm lint` clean
- [ ] 6.5 `examples/flux/` GitRepository plus Kustomization, and `examples/argocd/` Application
- [ ] 6.6 Example configs: minimal, nested with sets, and one exercising every documented field

## 7. Tooling, docs and CI

- [ ] 7.1 `tools/validate-config.mjs`: validate a config file from the command line using the same module as the browser, for use in a user's own CI or pre-commit
- [ ] 7.2 `README.md`: what it is, a screenshot, install in both tools, the config reference link, and a findable section on why there are no status indicators
- [ ] 7.3 `docs/CONFIGURATION.md`: full schema reference with defaults, and the `subPath` and immutable-ConfigMap limitations stated plainly
- [ ] 7.4 CI: `node --test`, formatting check, `kustomize build` of base and every example, `helm lint` and `helm template`, `kubeconform` over rendered manifests, and the `src/` size ceiling
- [ ] 7.5 Issue and pull request templates, and a `CONTRIBUTING.md` short enough to read

## 8. Release

- [ ] 8.1 Run the leak sweep over the whole tree and review what the first push will contain
- [ ] 8.2 Create the public repository and push
- [ ] 8.3 Verify the install path end to end from the published ref in a throwaway namespace, including a config edit picked up live
- [ ] 8.4 Tag `v0.1.0` and write release notes naming the kustomize ref users should pin
