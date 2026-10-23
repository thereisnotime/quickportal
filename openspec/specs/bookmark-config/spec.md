# bookmark-config Specification

## Purpose
TBD - created by archiving change config-driven-portal. Update Purpose after archive.
## Requirements
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

#### Scenario: Document-level error
- **WHEN** the config is unusable as a whole, such as not being a mapping or
  declaring a missing or future `version`
- **THEN** the page lists each error as `path: message` and renders no bookmark
  tree, because there is nothing trustworthy to render

#### Scenario: Entry-level error
- **WHEN** the config is usable but individual entries are not, such as an item
  with no `url` or one set with an unresolvable target
- **THEN** the offending entries are dropped, the errors are listed as
  `path: message` above the tree, and the rest of the tree renders, because one
  bad entry must not blank the whole portal

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

### Requirement: Embedding fields are validated
An item MAY carry `embed`, `allow` and `sandbox`, and a top level `embedding.maxFrames` MAY set the cap. Each SHALL be validated with a documented default.

#### Scenario: Valid embedding fields
- **WHEN** an item sets `embed: true` with `allow: [fullscreen]`
- **THEN** the config is accepted and the item is marked as embedded

#### Scenario: Wrong type for embed
- **WHEN** `embed` is a string rather than a boolean
- **THEN** a warning is reported at that path and the documented default of `false` is used

#### Scenario: Unknown allow token
- **WHEN** `allow` contains a token the portal does not recognise
- **THEN** a warning names the token and it is dropped, because an unknown permission must not be passed through blindly

#### Scenario: Embedding a non-embeddable scheme
- **WHEN** an item sets `embed: true` on a URL whose scheme cannot be framed, such as a `mailto:` or `magnet:` link
- **THEN** a warning is reported at that path, the item keeps working as a bookmark that opens in a browser tab, and it is absent from the embedded set, because the embed request is impossible but the bookmark is not

#### Scenario: Cap out of range
- **WHEN** `embedding.maxFrames` is zero, negative or not an integer
- **THEN** a warning is reported and the documented default is used

