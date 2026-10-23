## ADDED Requirements

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
