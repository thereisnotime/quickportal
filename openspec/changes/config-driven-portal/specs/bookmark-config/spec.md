## ADDED Requirements

### Requirement: Config is accepted as YAML or JSON
The portal SHALL accept its configuration as either YAML or JSON from a single file, choosing the parser by content rather than by file extension.

#### Scenario: JSON config
- **WHEN** the config file contains valid JSON
- **THEN** it is parsed with `JSON.parse` and the YAML parser is never invoked

#### Scenario: YAML config
- **WHEN** the config file contains YAML that is not valid JSON
- **THEN** it is parsed with the vendored YAML parser and rendered identically to the equivalent JSON

#### Scenario: Neither
- **WHEN** the config file is neither valid JSON nor valid YAML
- **THEN** the page renders an error naming the parse failure and its line, and no bookmarks

### Requirement: Config declares a schema version
The config MUST declare `version`, and the portal SHALL refuse a version it does not implement rather than guessing.

#### Scenario: Known version
- **WHEN** `version: 1` is present
- **THEN** the config is processed normally

#### Scenario: Missing version
- **WHEN** `version` is absent
- **THEN** an error is reported at path `version` stating that it is required

#### Scenario: Future version
- **WHEN** `version` is greater than the implemented version
- **THEN** an error states the config needs a newer portal, and nothing is rendered from it

### Requirement: Groups nest arbitrarily
A group SHALL contain items, further groups, or both, to any depth up to a documented limit.

#### Scenario: Nested groups render as a tree
- **WHEN** a group contains a `groups` list whose members contain their own items
- **THEN** every level is rendered, each level collapsible independently

#### Scenario: Depth limit exceeded
- **WHEN** nesting exceeds five levels
- **THEN** a warning is reported naming the path, and the tree is rendered truncated at the limit rather than failing

### Requirement: Identifiers are stable and unique
Every group and item SHALL have an identifier, supplied explicitly or derived from its name within its parent path, and identifiers MUST be unique across the config.

#### Scenario: Derived identifier
- **WHEN** an item has a name but no `id`
- **THEN** an id is derived by slugifying the name within its parent path, and is stable across reloads of an unchanged config

#### Scenario: Duplicate identifier
- **WHEN** two entries resolve to the same id
- **THEN** an error is reported naming both paths, rather than one silently replacing the other

### Requirement: An invalid config never produces a blank page
The portal SHALL always render something explaining what is wrong, and SHALL distinguish errors from warnings.

#### Scenario: Errors present
- **WHEN** the config has one or more errors
- **THEN** the page lists each as `path: message` and renders no bookmark tree

#### Scenario: Warnings only
- **WHEN** the config has warnings but no errors, such as an unknown key
- **THEN** the bookmark tree renders in full and the warnings are shown in a dismissible notice

#### Scenario: Config missing entirely
- **WHEN** the config file cannot be fetched at all
- **THEN** the page explains that the config is missing and names the path it tried, instead of rendering empty

### Requirement: Optional fields have documented defaults
Every field except `version` and the bookmark content SHALL be optional, with a default documented alongside the schema.

#### Scenario: Minimal config
- **WHEN** the config declares only `version` and one group with one item
- **THEN** the page renders with default title, theme, density and reload interval, and reports no errors
