## ADDED Requirements

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

### Requirement: Live rendering of a diagram language is opt-in and costs a policy change
The portal MAY import an operator-supplied renderer module to turn diagram source into SVG. It SHALL be absent unless configured, and its output SHALL pass through the same sanitiser.

#### Scenario: Renderer not configured
- **WHEN** no renderer is configured
- **THEN** no third-party code is imported and the served `script-src` is unchanged

#### Scenario: Renderer configured and permitted
- **WHEN** a renderer URL is configured and the deployment permits that origin in `script-src`
- **THEN** the source is rendered, sanitised and displayed

#### Scenario: Renderer configured but not permitted
- **WHEN** a renderer URL is configured and the deployment's policy forbids it
- **THEN** a notice names the policy as the thing to change, in the same way as for embedding

#### Scenario: Renderer output is not trusted
- **WHEN** a renderer returns SVG containing a script element
- **THEN** it is sanitised exactly as a supplied file would be
