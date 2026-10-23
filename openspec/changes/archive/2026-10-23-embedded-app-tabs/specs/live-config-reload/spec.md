## MODIFIED Requirements

### Requirement: Re-render preserves what the user is doing
A re-render triggered by a config change SHALL preserve scroll position, collapse state, search query and focus, and SHALL leave any mounted embedded frame untouched.

#### Scenario: Mid-search re-render
- **WHEN** the config changes while the user has typed a query and scrolled down
- **THEN** after the re-render the query is still applied, the scroll position is retained, and focus has not moved

#### Scenario: Re-render with an embedded app open
- **WHEN** the config changes while an embedded app is mounted and in use
- **THEN** the frame is not reloaded, reparented or replaced, so the state inside it survives
