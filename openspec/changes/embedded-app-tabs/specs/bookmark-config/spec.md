## ADDED Requirements

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
- **THEN** an error is reported at that path, since the item could never open

#### Scenario: Cap out of range
- **WHEN** `embedding.maxFrames` is zero, negative or not an integer
- **THEN** a warning is reported and the documented default is used
