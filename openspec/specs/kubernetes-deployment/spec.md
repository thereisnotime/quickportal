# kubernetes-deployment Specification

## Purpose
TBD - created by archiving change config-driven-portal. Update Purpose after archive.
## Requirements
### Requirement: Deployable without building or publishing an image
A user SHALL be able to deploy the portal by referencing this repository and supplying their own config, with no image build, no registry and no bundled chart required.

#### Scenario: Kustomize install
- **WHEN** a user adds this repository's kustomize base at a tagged ref plus a ConfigMap holding their config
- **THEN** `kustomize build` produces a working Deployment, Service and ConfigMaps with no further tooling

#### Scenario: Only an upstream image is pulled
- **WHEN** the manifests are applied
- **THEN** the only container image referenced is a pinned upstream web server, and none is published by this project

### Requirement: Application files and user config are separate ConfigMaps
The app SHALL ship as a generated ConfigMap whose name changes with its content, and the user's config SHALL live in a separate ConfigMap that the user owns.

#### Scenario: App upgrade
- **WHEN** the app files change and the user upgrades the ref
- **THEN** the generated ConfigMap name changes and the pod rolls

#### Scenario: Config edit
- **WHEN** only the user's config ConfigMap changes
- **THEN** no pod roll occurs and the running pod serves the new config

#### Scenario: Never mounted with subPath
- **WHEN** the shipped manifests are rendered
- **THEN** no ConfigMap volume uses `subPath`, because kubelet never updates such a mount

### Requirement: The pod runs hardened by default
The shipped manifests SHALL run as a non-root user with a read-only root filesystem, all capabilities dropped, no privilege escalation and the default seccomp profile.

#### Scenario: Rendered security context
- **WHEN** the manifests are rendered
- **THEN** the pod sets `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]` and `seccompProfile: RuntimeDefault`

#### Scenario: Writable paths
- **WHEN** the web server needs scratch space
- **THEN** it is provided by `emptyDir`, not by relaxing the read-only root filesystem

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

### Requirement: Flux and Argo CD paths are both documented and validated
The repository SHALL provide working examples for both tools, and CI SHALL validate the rendered manifests.

#### Scenario: Flux example
- **WHEN** a user applies the Flux example
- **THEN** a GitRepository and Kustomization deploy the portal with their own config ConfigMap

#### Scenario: Argo example
- **WHEN** a user applies the Argo CD example
- **THEN** an Application deploys the portal from this repository with their own config ConfigMap

#### Scenario: CI validation
- **WHEN** CI runs on a pull request
- **THEN** every example and the chart are rendered and schema-validated, and the job fails on an invalid manifest

### Requirement: Size and platform limits are enforced and documented
The shipped application SHALL stay well inside the ConfigMap size limit, and the documented limitations of ConfigMap-based delivery SHALL be stated where users will find them.

#### Scenario: Size ceiling in CI
- **WHEN** the application files exceed the documented ceiling
- **THEN** CI fails naming the total size, before a cluster rejects the ConfigMap

#### Scenario: Documented limitations
- **WHEN** a user reads the deployment documentation
- **THEN** it states that `subPath` mounts and immutable ConfigMaps never update, and that live reload cannot work in those cases

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

