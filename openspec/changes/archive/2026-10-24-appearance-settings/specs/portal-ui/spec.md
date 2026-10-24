## MODIFIED Requirements

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

## ADDED Requirements

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
