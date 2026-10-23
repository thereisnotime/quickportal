## ADDED Requirements

### Requirement: A set opens all its targets in one action
The config SHALL support named sets of targets, and activating a set SHALL open every resolved target.

#### Scenario: Set of three
- **WHEN** the user activates a set listing three resolvable targets
- **THEN** three tabs open, one per target, and the portal reports that three opened

#### Scenario: Set referencing a group
- **WHEN** a set target names a group id
- **THEN** every item beneath that group opens, depth-first in config order

#### Scenario: Set referencing a bare URL
- **WHEN** a set target is a URL not present anywhere in the tree
- **THEN** it opens as given

### Requirement: Blocked popups are reported, never swallowed
When the browser refuses to open a target, the portal SHALL tell the user and offer the blocked targets as links.

#### Scenario: Popup blocker intervenes
- **WHEN** the browser blocks some of a set's targets
- **THEN** the portal lists exactly the blocked targets as clickable links and states that the browser blocked them

#### Scenario: All blocked
- **WHEN** every target is blocked
- **THEN** the portal says none opened and explains how to allow popups for this origin

### Requirement: Large sets confirm before opening
To prevent an accidental tab storm, a set above a documented size SHALL require confirmation.

#### Scenario: Oversized set
- **WHEN** the user activates a set resolving to more than ten targets
- **THEN** the portal asks for confirmation stating the count, and opens nothing until confirmed

### Requirement: Unresolvable targets are reported at validation time
A target that matches no item, group or URL SHALL be a config error, surfaced before the user clicks anything.

#### Scenario: Typo in a target
- **WHEN** a set lists a target id that exists nowhere in the config
- **THEN** an error is reported naming the set and the unresolved target

#### Scenario: Partially valid set
- **WHEN** a set has both valid and unresolved targets
- **THEN** the error names the unresolved ones and the set still opens the valid ones when activated
