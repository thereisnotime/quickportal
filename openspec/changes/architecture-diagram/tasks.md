## 1. Config layer

- [ ] 1.1 Accept and validate the `diagram` section: `title`, `src`, `maxBytes` with a documented default, and the optional `renderer` with `url` and `source`
- [ ] 1.2 Reject a renderer URL that is neither an absolute HTTPS URL nor a same-origin path, since that field decides what code the page imports
- [ ] 1.3 Surface the diagram configuration on the normalized config, and remember the panel's open state in `state.js`
- [ ] 1.4 Tests for every scenario in the `bookmark-config` delta

## 2. Sanitiser

- [ ] 2.1 `src/assets/diagram.js`: parse with `DOMParser` as `image/svg+xml`, never as markup, with `DOMParser`, `XMLSerializer` and `document` injected so it is testable in plain Node
- [ ] 2.2 Rebuild against an element and attribute allowlist, dropping scripts, `on*` handlers, `foreignObject`, animation elements and `base`
- [ ] 2.2b Extract `style` elements and `style` attributes rather than dropping them: filter the declarations, scope them to the diagram container, and apply them through a constructed stylesheet and `setProperty`, so a renderer's output keeps its appearance under `style-src 'self'`
- [ ] 2.3 Keep fragment references, drop external and `javascript:` references on every reference-bearing attribute
- [ ] 2.4 Report what was dropped, as counts, so the panel can tell the operator their diagram was altered
- [ ] 2.5 Adversarial tests: one fixture per dangerous construct, asserting removal, plus a legitimate diagram asserting nothing is dropped

## 3. Fetch, panel and export

- [ ] 3.1 `fetchDiagram` with the size limit enforced before parsing, and distinct outcomes for missing, oversized and unparseable
- [ ] 3.2 Lazy fetch on first open, cached until the configuration changes
- [ ] 3.3 `renderDiagramPanel`: pan, zoom, fit-to-view, the drop notice, and every failure state as a notice that leaves the bookmarks working
- [ ] 3.4 Keyboard operation for toggle, zoom, fit and export, with the zoom level conveyed, and pan without a pointer
- [ ] 3.5 `serializeSvg` and `toPng(scale)` using canvas, with no dependency and no network
- [ ] 3.6 Preserve pan, zoom and open state across a config re-render

## 4. Rendering diagram source in the page

- [ ] 4.1 Import the configured renderer module and render the config's source through it, then through the sanitiser, with a clear panel message when the origin is unreachable
- [ ] 4.2 Detect our own `script-src` refusing the import and name the policy as the thing to change
- [ ] 4.3 Make `script-src` configurable in the server config, defaulting to this origin only
- [ ] 4.4 Helm value and kustomize patch for the renderer origin, plus the chart refusing the half-configured state
- [ ] 4.5 CI assertion that with no renderer configured the policy and manifests are unchanged from v0.2.0

## 5. Documentation

- [ ] 5.1 Configuration reference for the `diagram` section and the size budget
- [ ] 5.2 `docs/DIAGRAM.md`: authoring to SVG with any tool, the one-command CI step for a diagram language, the sanitiser's allowlist and why it exists, font substitution in PNG export
- [ ] 5.3 State plainly that the renderer hook executes code the project did not ship, and that self-hosting is strongly preferred
- [ ] 5.4 README: a diagram is optional, supplied as SVG, and why the project does not bundle a renderer

## 6. Release

- [ ] 6.1 Verify on a cluster: a real diagram delivered by ConfigMap, updated without a restart, and both exports
- [ ] 6.2 Confirm a deployment with no diagram is unchanged on the wire
- [ ] 6.3 Tag the minor release
