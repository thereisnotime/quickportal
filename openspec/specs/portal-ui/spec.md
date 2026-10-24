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
The portal SHALL support light, dark and automatic themes, SHALL default to automatic, SHALL present all three as visible options in the settings menu with the current one marked, and SHALL let the user override and persist the choice.

#### Scenario: Automatic
- **WHEN** `theme: auto` is set and the OS reports a dark preference
- **THEN** the page renders dark, and switches live if the OS preference changes

#### Scenario: User override
- **WHEN** the user picks a theme in the settings menu
- **THEN** that choice persists across reloads and takes precedence over the config value

#### Scenario: All three states are visible
- **WHEN** the settings menu is open
- **THEN** auto, light and dark are all shown, the active one is marked as selected, and any of the three can be chosen in a single activation

#### Scenario: Choosing auto is a choice
- **WHEN** the user picks auto after having picked dark
- **THEN** the page follows the system preference, and a later config change to `theme:` still does not override it

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
An item icon MAY be text, a URL or `auto`, and a failure to load one MUST NOT leave a broken image. Every icon variant SHALL render at the same size for a given context, and SHALL NOT influence the layout of the item it belongs to.

#### Scenario: Icon fails to load
- **WHEN** an icon URL returns an error or times out
- **THEN** the item falls back to initials derived from its name, with no broken-image glyph

#### Scenario: Automatic icon
- **WHEN** an item sets `icon: auto`
- **THEN** the portal attempts the origin's favicon and falls back to initials on failure

#### Scenario: Every variant is the same size
- **WHEN** one item uses an emoji, another a URL and another falls back to initials
- **THEN** all three icons render at the same size, and each card lays out identically apart from its text

#### Scenario: An image icon does not resize its card
- **WHEN** an item's icon is a URL, whatever the source image's pixel dimensions
- **THEN** the icon is contained within the icon box, the item's name stays on one line, and the card is the same height as a card whose icon is an emoji

#### Scenario: Smaller contexts
- **WHEN** an icon is shown in a group heading or an open app's tab rather than on a card
- **THEN** it renders smaller there, and every variant follows that size

### Requirement: The page carries no inline script or style
All behaviour and styling SHALL load from separate files so a strict Content-Security-Policy applies without `unsafe-inline`.

#### Scenario: Strict CSP
- **WHEN** the page is served with `script-src 'self'; style-src 'self'`
- **THEN** it renders and functions with no CSP violation reported in the console

### Requirement: Mounted frames live outside the re-rendered tree
The element holding mounted frames SHALL NOT be a descendant of any part of the DOM that rendering replaces or reparents, because moving an `iframe` in the DOM reloads it in every browser.

#### Scenario: Config change while a frame is mounted
- **WHEN** the config changes, including a change that renames the embedded item or moves it to another group
- **THEN** the frame element is the same node afterwards and has not reloaded

#### Scenario: Embedded item deleted from the config
- **WHEN** an embedded item is removed from the config while its tab is open
- **THEN** the tab is closed and a notice says why, rather than leaving a tab pointing at nothing

### Requirement: The tab strip is keyboard operable
The tab strip SHALL be reachable and operable by keyboard, following the same focus rules as the rest of the page.

#### Scenario: Moving between tabs
- **WHEN** the strip has focus and the user presses the arrow keys
- **THEN** focus moves between tabs, and the focused tab is visibly indicated in both themes

#### Scenario: Closing from the keyboard
- **WHEN** a tab has focus and the user activates its close action
- **THEN** that tab closes and focus moves to a predictable neighbour rather than being lost to the document

#### Scenario: Screen reader announcement
- **WHEN** a tab is focused
- **THEN** its accessible name is the item's name, and the strip conveys the selected tab and the total

### Requirement: The diagram panel is collapsible and keyboard operable
The diagram SHALL be a collapsible panel in the page rather than a route or a modal, with its open state remembered per browser.

#### Scenario: Toggling
- **WHEN** the user opens or closes the panel
- **THEN** the state persists across reloads and the bookmark tree stays visible and usable

#### Scenario: Keyboard
- **WHEN** the panel has focus
- **THEN** the toggle, the zoom controls, fit-to-view and both export actions are reachable and operable by keyboard, with visible focus in both themes

#### Scenario: Pan and zoom without a mouse
- **WHEN** the user operates the panel from the keyboard
- **THEN** panning and zooming are possible without a pointer, and the current zoom level is conveyed

#### Scenario: Re-render while open
- **WHEN** the config changes while the panel is open
- **THEN** the panel stays open, the diagram is not refetched unless its configuration changed, and the pan and zoom position is retained

### Requirement: Appearance preferences live in one settings menu
The portal SHALL present its appearance preferences (theme, contrast, density and motion) in a single popup opened from one toolbar control, and SHALL NOT require a separate toolbar control per preference.

#### Scenario: Opening and closing
- **WHEN** the user activates the settings control
- **THEN** a modal popup opens listing every appearance preference with its current value marked

#### Scenario: Closing returns focus
- **WHEN** the popup is closed by Escape, by the close control, or by clicking outside it
- **THEN** focus returns to the control that opened it

#### Scenario: Keyboard only
- **WHEN** the user navigates the popup with Tab and the arrow keys
- **THEN** every preference group is reachable, the arrow keys move within a group, and the focused control has a visible focus indicator in every theme and contrast combination

#### Scenario: Changes apply immediately
- **WHEN** the user selects a different value for any preference
- **THEN** the page updates without being reloaded and the popup stays open, so the effect is visible while choosing

#### Scenario: Announced to assistive technology
- **WHEN** a preference changes
- **THEN** the new value is announced, and each group exposes its own accessible name

#### Scenario: Reachable without the popup
- **WHEN** the user opens the command palette
- **THEN** each appearance preference can be changed from there, and the popup itself can be opened from there

### Requirement: Contrast is a viewer preference with a system default
The portal SHALL offer automatic, normal and high contrast, SHALL default to automatic, and SHALL treat automatic as following the operating system's increased-contrast preference.

#### Scenario: Following the system
- **WHEN** contrast is automatic and the OS reports a preference for more contrast
- **THEN** the page renders in high contrast, and switches live if the OS preference changes

#### Scenario: Explicit high contrast
- **WHEN** the user selects high contrast
- **THEN** borders, body text and focus indicators are rendered at increased strength, and the choice persists across reloads regardless of the OS preference

#### Scenario: Explicit normal contrast
- **WHEN** the user selects normal contrast while the OS reports a preference for more contrast
- **THEN** the page renders in normal contrast, because an explicit choice beats the system default

#### Scenario: High contrast in both themes
- **WHEN** high contrast is active
- **THEN** it applies in light and in dark, body text meets at least 4.5:1 against its background, and borders and focus indicators meet at least 3:1

#### Scenario: No operator override
- **WHEN** the config is loaded
- **THEN** it cannot set or force a contrast value, because contrast belongs to the viewer

### Requirement: Density is a viewer preference over the config default
The portal SHALL let the viewer choose comfortable or compact density, SHALL use `layout.density` from the config when the viewer has not chosen, and SHALL give the viewer's choice precedence once made.

#### Scenario: Config supplies the default
- **WHEN** the config sets `layout.density: compact` and the browser has no remembered choice
- **THEN** the page renders compact

#### Scenario: Viewer choice wins
- **WHEN** the viewer selects comfortable and the config sets `layout.density: compact`
- **THEN** the page renders comfortable, and stays comfortable across live config reloads

#### Scenario: Applied to the whole page
- **WHEN** a density is active
- **THEN** it applies to the toolbar, the bookmark tree, the tab strip and the dialogs alike, not only to the bookmark tree

#### Scenario: Touch targets are not shrunk on touch
- **WHEN** compact density is active on a device without a precise pointer
- **THEN** interactive targets remain at least 44px in their smaller dimension

### Requirement: Motion can be reduced by the viewer
The portal SHALL offer a motion preference of system or reduced, SHALL default to system, and SHALL honour `prefers-reduced-motion` whichever is selected.

#### Scenario: Following the system
- **WHEN** motion is set to system and the OS reports a preference for reduced motion
- **THEN** transitions and animations are suppressed

#### Scenario: Forced by the viewer
- **WHEN** the viewer selects reduced motion and the OS reports no such preference
- **THEN** transitions and animations are suppressed anyway, and the choice persists across reloads

#### Scenario: The system preference cannot be overridden upward
- **WHEN** the OS reports a preference for reduced motion
- **THEN** no setting in the portal re-enables animation

### Requirement: Preferences survive unavailable storage
Every appearance preference SHALL be stored per browser, SHALL be read independently of the others, and SHALL fall back to its default when storage is unavailable or holds an unrecognised value.

#### Scenario: Storage throws
- **WHEN** `localStorage` throws or is unavailable
- **THEN** the page renders at every preference's default, the settings popup still opens, and changing a preference still applies for the session

#### Scenario: One key is corrupt
- **WHEN** one preference's stored value is not a recognised option
- **THEN** that preference falls back to its default and the others are unaffected

#### Scenario: Independent defaults
- **WHEN** a viewer has chosen a theme but nothing else
- **THEN** the theme is restored and contrast, density and motion are at their defaults, with density still taking the config's value

