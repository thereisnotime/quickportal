## ADDED Requirements

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
