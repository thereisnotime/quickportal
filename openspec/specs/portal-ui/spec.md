# portal-ui Specification

## Purpose
TBD - created by archiving change config-driven-portal. Update Purpose after archive.
## Requirements
### Requirement: Groups render as collapsible folders with remembered state
Groups SHALL render as folders the user can collapse, and the browser SHALL remember each folder's state by identifier.

#### Scenario: Collapse persists across a reload
- **WHEN** the user collapses a group and reloads the page
- **THEN** that group is still collapsed and others are unchanged

#### Scenario: Initial state from config
- **WHEN** a group declares `collapsed: true` and the browser has no remembered state for it
- **THEN** it renders collapsed

#### Scenario: Remembered state wins over config
- **WHEN** the browser has a remembered state for a group and the config declares the opposite
- **THEN** the remembered state is used, so a config edit does not fight the user's own choice

#### Scenario: Storage unavailable
- **WHEN** `localStorage` throws or is unavailable
- **THEN** the page still renders and collapsing still works for the session

### Requirement: Layout is responsive from 320px to wide desktop
The portal SHALL be usable without horizontal scrolling at 320px width, and SHALL use the available width on a wide display.

#### Scenario: Narrow phone
- **WHEN** the viewport is 320px wide
- **THEN** there is no horizontal page scroll, and every interactive target is at least 44px in its smaller dimension

#### Scenario: Wide desktop
- **WHEN** the viewport is 2560px wide
- **THEN** items flow into multiple columns rather than one long list, bounded by a readable maximum width

### Requirement: Theme follows the system with a user override
The portal SHALL support light, dark and automatic themes, SHALL default to automatic, and SHALL let the user override and persist the choice.

#### Scenario: Automatic
- **WHEN** `theme: auto` is set and the OS reports a dark preference
- **THEN** the page renders dark, and switches live if the OS preference changes

#### Scenario: User override
- **WHEN** the user picks a theme in the UI
- **THEN** that choice persists across reloads and takes precedence over the config value

### Requirement: Search filters the tree
The portal SHALL filter visible bookmarks as the user types, matching name, description, tags and URL.

#### Scenario: Matching
- **WHEN** the user types a query matching items in collapsed groups
- **THEN** those groups expand to reveal the matches and non-matching entries are hidden

#### Scenario: No matches
- **WHEN** the query matches nothing
- **THEN** the page says so and offers to clear the query, rather than showing an empty page

#### Scenario: Clearing
- **WHEN** the query is cleared
- **THEN** the tree returns to its previous collapse state

### Requirement: The portal is keyboard operable
Every action SHALL be reachable by keyboard, with a documented set of shortcuts.

#### Scenario: Focus search
- **WHEN** the user presses the search shortcut
- **THEN** focus moves to the search input without the page scrolling

#### Scenario: Open from the keyboard
- **WHEN** an item has focus and the user presses Enter
- **THEN** that item opens, honouring its `target`

#### Scenario: Visible focus
- **WHEN** the user navigates with Tab
- **THEN** the focused element has a visible focus indicator that meets contrast requirements in both themes

### Requirement: Icons degrade gracefully
An item icon MAY be text, a URL or `auto`, and a failure to load one MUST NOT leave a broken image.

#### Scenario: Icon fails to load
- **WHEN** an icon URL returns an error or times out
- **THEN** the item falls back to initials derived from its name, with no broken-image glyph

#### Scenario: Automatic icon
- **WHEN** an item sets `icon: auto`
- **THEN** the portal attempts the origin's favicon and falls back to initials on failure

### Requirement: The page carries no inline script or style
All behaviour and styling SHALL load from separate files so a strict Content-Security-Policy applies without `unsafe-inline`.

#### Scenario: Strict CSP
- **WHEN** the page is served with `script-src 'self'; style-src 'self'`
- **THEN** it renders and functions with no CSP violation reported in the console

