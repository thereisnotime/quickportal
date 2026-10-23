## ADDED Requirements

### Requirement: The diagram section is validated
The config MAY carry a `diagram` section with `title`, `src`, `maxBytes` and an optional `renderer`. Each field SHALL be validated, with a documented default where one applies.

#### Scenario: Valid diagram section
- **WHEN** `diagram.src` is a usable path and `maxBytes` is a positive integer
- **THEN** the config is accepted and the diagram is marked as configured

#### Scenario: Missing src
- **WHEN** a `diagram` section omits `src` and configures no renderer
- **THEN** an error is reported at `diagram.src`, since there is nothing to show

#### Scenario: maxBytes out of range
- **WHEN** `maxBytes` is zero, negative, not an integer, or larger than the ConfigMap can hold
- **THEN** a warning is reported and the documented default is used

#### Scenario: Renderer without source
- **WHEN** `diagram.renderer.url` is set but no source file is named
- **THEN** an error is reported, because a renderer with nothing to render is a misconfiguration

#### Scenario: Unsafe renderer URL
- **WHEN** `diagram.renderer.url` is not an absolute HTTPS URL or a same-origin path
- **THEN** an error is reported, because this field decides what code the page imports
