## ADDED Requirements

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
The shipped server config SHALL serve the config file revalidated per request and the static assets cacheable, under a strict Content-Security-Policy.

#### Scenario: Config headers
- **WHEN** the config file is requested
- **THEN** the response carries an `ETag` and a `Cache-Control` that forces revalidation

#### Scenario: Asset headers
- **WHEN** a file under the assets path is requested
- **THEN** the response is cacheable long-term, which is safe because the ConfigMap name is content-hashed

#### Scenario: Policy headers
- **WHEN** any page is served
- **THEN** it carries a Content-Security-Policy restricting scripts and styles to the same origin, images to the same origin plus HTTPS, and framing to none

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
