## ADDED Requirements

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
