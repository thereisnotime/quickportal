## MODIFIED Requirements

### Requirement: Serving headers support live reload and a strict policy
The shipped server config SHALL serve the config file revalidated per request and the static assets cacheable, under a strict Content-Security-Policy whose framing permissions are configurable and forbidden by default.

#### Scenario: Config headers
- **WHEN** the config file is requested
- **THEN** the response carries an `ETag` and a `Cache-Control` that forces revalidation

#### Scenario: Asset headers
- **WHEN** a static asset is requested
- **THEN** the response carries an `ETag` and a `Cache-Control` that permits caching but requires revalidation, because the content hash is in the ConfigMap name rather than in the URL, so a long-lived immutable copy would let a stale asset run against newly served markup

#### Scenario: Policy headers
- **WHEN** any page is served
- **THEN** it carries a Content-Security-Policy restricting scripts and styles to the same origin, images to the same origin plus HTTPS, framing of this page to none, and framing by this page to none

#### Scenario: Framing permitted for embedding
- **WHEN** the deployment sets the permitted frame origins
- **THEN** `frame-src` lists exactly those origins and nothing else changes in the policy

#### Scenario: Default forbids framing
- **WHEN** the deployment sets no frame origins
- **THEN** the policy served on the wire is byte-identical to the policy served before this feature existed, for every path

## ADDED Requirements

### Requirement: Enabling embedding is a deliberate two-part change
Permitting framing SHALL require a deployment-level change as well as a config-level one, and the half-configured state SHALL be reported on the page.

#### Scenario: Item opts in while the policy forbids it
- **WHEN** a config marks an item as embedded but the served policy still forbids framing
- **THEN** the page reports that the deployment's policy forbids framing and names what has to change, rather than showing a blank frame

#### Scenario: Both parts in place
- **WHEN** the policy permits the origin and the item opts in
- **THEN** the frame mounts normally

#### Scenario: Unused feature changes nothing
- **WHEN** no item is embedded and no frame origins are set
- **THEN** every response header is byte-identical to the previous release's, and the rendered manifests differ from it only by the directives that implement the switch, compared against the released tag rather than a fixture

Byte-identical *manifests* is not the test, because any implementation of a configurable directive changes the file holding it. Stating it that way invites either a weakened smoke test or the conclusion that the requirement cannot be met. What is enforceable, and what this scenario means, is that the served policy does not move and the manifest diff contains nothing but the switch.
