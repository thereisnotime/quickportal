# architecture-diagram Specification

## Purpose
TBD - created by archiving change architecture-diagram. Update Purpose after archive.
## Requirements
### Requirement: A diagram is displayed from an operator-supplied SVG
The portal MAY show a diagram, supplied as SVG by the operator and delivered beside their config. The portal SHALL NOT require any particular authoring tool.

#### Scenario: Diagram configured
- **WHEN** `diagram.src` names a reachable SVG within the size limit
- **THEN** a panel shows it, with pan, zoom and fit-to-view

#### Scenario: No diagram configured
- **WHEN** the config has no `diagram` section
- **THEN** no panel is rendered, nothing is fetched, and no policy changes

#### Scenario: Updated without a restart
- **WHEN** the operator commits a new SVG to the same ConfigMap key
- **THEN** the next open shows the new diagram, with no pod restart

### Requirement: The diagram is fetched only when first opened
Fetching SHALL be lazy, so a large diagram costs nothing until someone looks at it.

#### Scenario: Panel never opened
- **WHEN** the page loads with a diagram configured and the panel closed
- **THEN** the SVG is not requested

#### Scenario: Panel opened
- **WHEN** the user opens the panel for the first time
- **THEN** the SVG is requested once and reused on subsequent opens until the config changes

### Requirement: An inlined SVG is sanitised against an allowlist
The SVG SHALL be parsed and rebuilt against an allowlist of elements and attributes, never assigned as markup, because an SVG is executable content.

#### Scenario: Script in the diagram
- **WHEN** the SVG contains a `script` element or an `on*` attribute
- **THEN** they are removed before the diagram enters the document

#### Scenario: External reference in the diagram
- **WHEN** the SVG references an external URL through `href`, `xlink:href`, `src` or a CSS `url()`
- **THEN** that reference is removed, while fragment references to ids within the same document are kept

#### Scenario: Embedded HTML in the diagram
- **WHEN** the SVG contains `foreignObject`, animation elements or a `base` element
- **THEN** they are removed

#### Scenario: The operator is told their diagram was altered
- **WHEN** sanitisation removes anything
- **THEN** the diagram still renders and the panel states how much was dropped, because silently altering someone's diagram is worse than telling them

#### Scenario: A legitimate diagram is unharmed
- **WHEN** the SVG contains only shapes, paths, text, groups, gradients, markers and fragment references
- **THEN** nothing is dropped and the rendered diagram is equivalent to the source

### Requirement: The diagram can be exported
The panel SHALL offer export to SVG and to PNG, computed in the browser from what is displayed, with no dependency and no network request.

#### Scenario: Export SVG
- **WHEN** the user exports SVG
- **THEN** the sanitised diagram is serialised and offered as a file

#### Scenario: Export PNG
- **WHEN** the user exports PNG
- **THEN** the diagram is drawn to a canvas at a documented scale and offered as a file

#### Scenario: Fonts in the export
- **WHEN** the diagram's text depends on a font the browser substituted
- **THEN** the exported PNG shows the substituted font, and the documentation says so rather than leaving it to be discovered

### Requirement: A failing diagram never breaks the page
Every diagram failure SHALL degrade to a notice, leaving the bookmarks fully usable.

#### Scenario: Diagram missing
- **WHEN** `diagram.src` is configured but the file cannot be fetched
- **THEN** a notice names the path it tried and the bookmark tree renders normally

#### Scenario: Diagram too large
- **WHEN** the file exceeds the configured or default size limit
- **THEN** it is not inlined, and a notice names the actual and permitted sizes

#### Scenario: Diagram not parseable
- **WHEN** the file is not valid SVG
- **THEN** a notice names the parse failure and the bookmark tree renders normally

### Requirement: Diagram source is rendered in the page by a renderer the operator names
The portal MAY import a renderer module named by the operator and use it to turn diagram source in the config into SVG. The import SHALL be absent unless configured, and the output SHALL pass through the same sanitiser as a supplied file.

#### Scenario: Renderer not configured
- **WHEN** no renderer is configured
- **THEN** no third-party code is imported and the served `script-src` is unchanged

#### Scenario: Renderer configured and permitted
- **WHEN** a renderer URL is configured and the deployment permits that origin in `script-src`
- **THEN** the source from the config is rendered, sanitised and displayed

#### Scenario: Renderer unreachable, with no fallback configured
- **WHEN** the renderer's origin cannot be reached, such as on a machine with no route to it, and no `src` is configured
- **THEN** the panel states that the diagram needs that origin, and the bookmarks are unaffected

#### Scenario: Renderer unreachable, with a committed SVG configured
- **WHEN** the renderer cannot be imported and `src` names a pre-rendered SVG
- **THEN** that SVG is shown instead, with a notice saying it is the committed copy and why, because an operator with no route to their renderer should get their diagram rather than an apology

#### Scenario: Renderer loaded but rejected the source
- **WHEN** the renderer imports successfully and then fails on the diagram source
- **THEN** the failure is reported and a configured `src` is NOT substituted, because showing an older picture would hide the author's mistake

#### Scenario: Rendered output exceeds the size limit
- **WHEN** the renderer produces an SVG larger than `maxBytes`
- **THEN** it is not sanitised or displayed, and the panel names the actual and permitted sizes, as it does for an oversized file

#### Scenario: Renderer configured but not permitted
- **WHEN** a renderer URL is configured and the deployment's policy forbids it
- **THEN** a notice names the policy as the thing to change, in the same way as for embedding

#### Scenario: Renderer output is not trusted
- **WHEN** a renderer returns SVG containing a script element
- **THEN** it is sanitised exactly as a supplied file would be

### Requirement: A renderer's stylesheet is preserved without loosening the policy
Renderer output carries a stylesheet its appearance depends on. The portal SHALL preserve that styling and SHALL NOT require `style-src 'unsafe-inline'` to do so.

#### Scenario: Styled renderer output
- **WHEN** the rendered SVG contains a `style` element whose rules its elements depend on
- **THEN** the rules are filtered, scoped to the diagram, and applied through the CSSOM, so the diagram looks as the renderer intended under `style-src 'self'`

#### Scenario: Dangerous CSS in that stylesheet
- **WHEN** the stylesheet contains `url(`, `@import`, `expression(` or `behavior:`
- **THEN** those declarations are removed before anything is applied

#### Scenario: Style attributes in renderer output
- **WHEN** the rendered SVG carries `style` attributes
- **THEN** their declarations are re-applied through the CSSOM rather than left as attributes

### Requirement: Inert constructs are preserved, not removed
The sanitiser SHALL keep constructs that cannot execute, reference anything, or escape the diagram, so that a diagram from a conforming renderer passes through unaltered.

#### Scenario: Renderer bookkeeping attributes
- **WHEN** a diagram carries `data-*` attributes
- **THEN** they are preserved, because nothing in the page can act on them and no script survives sanitisation

#### Scenario: Accessibility attributes
- **WHEN** a diagram carries `aria-*` attributes
- **THEN** they are preserved, so the diagram keeps whatever accessible description its renderer gave it

#### Scenario: Values are still checked
- **WHEN** a preserved attribute's value carries `javascript:`, `url()`, `@import`, `expression()` or `behavior:`
- **THEN** the attribute is removed, as for any other attribute

#### Scenario: A real diagram loses nothing
- **WHEN** a mermaid flowchart is rendered and sanitised
- **THEN** no element, attribute or style declaration is removed, and no alteration notice is shown

### Requirement: Document-root selectors are scoped, not refused
A `:root` or `:host` selector in a renderer's stylesheet SHALL be rewritten to the diagram container, so that custom properties defined there reach the diagram and nothing else.

#### Scenario: Custom properties survive
- **WHEN** a renderer's stylesheet defines custom properties on `:root`
- **THEN** those properties apply to the diagram and are not reported as removed

#### Scenario: Still confined
- **WHEN** a `:root` rule has been rewritten
- **THEN** every selector it produces is the container or a descendant of it, and the properties are not readable outside the panel

#### Scenario: A selector the rewrite does not claim
- **WHEN** a selector attaches `:root` to another compound, such as `.a:root`
- **THEN** the rule is refused and counted, as before

#### Scenario: Escapes are still refused
- **WHEN** a selector names `html`, `body`, `::backdrop` or `::view-transition`
- **THEN** the rule is refused and counted, whether or not it also names `:root`

#### Scenario: An exported file
- **WHEN** the filtered stylesheet is written into an exported standalone SVG
- **THEN** `:root` is kept as written, because in that file it is the `<svg>` the renderer meant

### Requirement: The alteration notice reports risk, not volume
The panel SHALL warn that a diagram was altered only when something was removed because it could execute or reach outside the diagram, and SHALL remove anything else quietly.

#### Scenario: Something dangerous was removed
- **WHEN** a script, an `on*` handler, a foreignObject, an external reference, or CSS carrying `url()`, `@import`, `expression()` or `behavior:` is removed
- **THEN** the notice appears and reports every removal, not only the dangerous ones, because the reader has to find them in their own diagram

#### Scenario: Only uncarriable constructs were removed
- **WHEN** the only removals are constructs the allowlist has no way to carry, such as a `@keyframes` block
- **THEN** no notice is shown, because nothing about the diagram was unsafe

#### Scenario: Missing labels are explained
- **WHEN** a foreignObject is removed
- **THEN** the notice names the renderer option that prevents it, because the labels are the visible loss and the cause is not guessable from a count

