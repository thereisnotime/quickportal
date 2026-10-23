## ADDED Requirements

### Requirement: script-src is configurable for the optional renderer, and forbidden by default
The served policy SHALL restrict scripts to this origin unless the deployment names additional origins, by the same two-part mechanism as framing.

#### Scenario: Default
- **WHEN** no renderer origin is configured
- **THEN** `script-src` lists only this origin, and the policy served is byte-identical to the previous release's

#### Scenario: Renderer origin permitted
- **WHEN** the deployment names a renderer origin
- **THEN** `script-src` lists exactly this origin plus that one, and nothing else in the policy changes

#### Scenario: Chart refuses the half-configured state
- **WHEN** the chart renders a config naming a renderer whose origin no entry permits
- **THEN** rendering fails, naming the renderer and the current policy

### Requirement: The diagram is delivered beside the operator's config
A diagram SHALL be delivered as a key in the operator's own ConfigMap, never in the application ConfigMap.

#### Scenario: Updating a diagram does not roll the pod
- **WHEN** only the diagram key changes
- **THEN** no ConfigMap name changes, so the pod is not rolled

#### Scenario: Budget documented
- **WHEN** an operator reads the deployment documentation
- **THEN** it states that the diagram shares the 1MiB ConfigMap with their config, and names the default size limit
