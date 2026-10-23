# live-config-reload Specification

## Purpose
TBD - created by archiving change config-driven-portal. Update Purpose after archive.
## Requirements
### Requirement: A changed config re-renders without a page reload
The portal SHALL detect a changed config at runtime and re-render, without a pod restart and without the user reloading the page.

#### Scenario: Config edited in the cluster
- **WHEN** the mounted config file changes and the poll interval elapses
- **THEN** the page re-renders from the new config within one interval

#### Scenario: Config becomes invalid
- **WHEN** the changed config is invalid
- **THEN** the errors are shown and the last known good render is kept rather than replaced with nothing

### Requirement: Revalidation is cheap
Polling SHALL use HTTP revalidation and SHALL NOT re-render on an unchanged body.

#### Scenario: Unchanged config
- **WHEN** a poll revalidates and the server answers `304 Not Modified`
- **THEN** nothing re-renders and no config is parsed

#### Scenario: New entity tag, same content
- **WHEN** the server returns `200` with a different `ETag` but byte-identical content
- **THEN** the content hash matches, and nothing re-renders

### Requirement: Polling respects the background
Polling SHALL pause while the page is hidden and resume promptly when it becomes visible.

#### Scenario: Tab hidden
- **WHEN** the page is hidden for an hour
- **THEN** no polls are issued during that time

#### Scenario: Tab revealed
- **WHEN** the page becomes visible again
- **THEN** one poll is issued immediately rather than waiting a full interval

### Requirement: Re-render preserves what the user is doing
A re-render triggered by a config change SHALL preserve scroll position, collapse state, search query and focus.

#### Scenario: Mid-search re-render
- **WHEN** the config changes while the user has typed a query and scrolled down
- **THEN** after the re-render the query is still applied, the scroll position is retained, and focus has not moved

### Requirement: Live reload is configurable and manually triggerable
The interval SHALL be configurable, zero SHALL disable polling, and a manual reload SHALL always be available.

#### Scenario: Disabled
- **WHEN** `reload.interval` is `0`
- **THEN** no polling occurs, and the manual reload control still works

#### Scenario: Manual reload
- **WHEN** the user activates the manual reload control
- **THEN** the config is refetched immediately, bypassing the interval

