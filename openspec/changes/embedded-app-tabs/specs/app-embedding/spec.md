## ADDED Requirements

### Requirement: An item may open inside the portal
An item MAY declare that it opens in a tab strip within the portal rather than in a browser tab. Embedding SHALL be off unless the item asks for it.

#### Scenario: Embedded item is opened
- **WHEN** the user activates an item declaring `embed: true`
- **THEN** the item is mounted in the portal's frame area, a tab for it appears in the strip and is focused, and no browser tab is opened

#### Scenario: Default is unchanged
- **WHEN** an item does not declare `embed`
- **THEN** it opens in a browser tab exactly as before, honouring its `target`

#### Scenario: Already open
- **WHEN** the user activates an embedded item whose tab is already mounted
- **THEN** that tab is focused and the frame is not reloaded, so whatever state it holds survives

### Requirement: Every embedded item keeps a way out to a browser tab
An embedded item SHALL always offer opening in a browser tab as well, because framing can fail for reasons the portal cannot see.

#### Scenario: Secondary action present
- **WHEN** an embedded item is rendered
- **THEN** a distinct, keyboard reachable action opens it in a browser tab instead

#### Scenario: Nothing useful has appeared
- **WHEN** a mounted frame has been up for several seconds
- **THEN** a dismissible, non-blocking strip at an edge of the frame area offers opening in a browser tab and links to the documented header requirements, worded conditionally rather than as a diagnosis

#### Scenario: A working app is never obscured
- **WHEN** the frame actually loaded and the user is using the embedded app
- **THEN** that strip MUST NOT cover, dim or interrupt it, because the portal cannot tell a loaded frame from a refused one and will therefore show the strip over working apps too

### Requirement: The portal does not claim to know whether framing was refused
The portal MUST NOT report that a target refused framing, because a cross-origin frame exposes neither its status nor its content and a wrong accusation sends the user to change headers for no reason.

#### Scenario: Target refuses framing
- **WHEN** a target's `X-Frame-Options` or `frame-ancestors` forbids this origin
- **THEN** the frame area shows the browser's own result and the portal offers the escape hatch, without asserting a cause

#### Scenario: Target is merely slow or erroring
- **WHEN** a target is slow, returning an error, or unreachable
- **THEN** the portal behaves identically to the refusal case, because it cannot distinguish them

### Requirement: Mounted frames are bounded and eviction is visible
The number of concurrently mounted frames SHALL be capped, configurable, and the cap and current count SHALL be visible. Exceeding it SHALL evict the least recently focused frame and say so.

#### Scenario: Within the cap
- **WHEN** fewer frames than the cap are mounted
- **THEN** opening another mounts it without affecting the others

#### Scenario: Cap reached
- **WHEN** the user opens an embedded item while the cap is reached
- **THEN** the least recently focused frame is closed, the new one is mounted, and a notice names what was closed

#### Scenario: Count is visible
- **WHEN** any frame is mounted
- **THEN** the strip shows how many are mounted against the cap

### Requirement: Frames can be refreshed and closed, individually and as a group
Refreshing a frame SHALL be explicit, never automatic, because it is a navigation that discards the embedded app's state.

#### Scenario: Refresh one
- **WHEN** the user refreshes a tab
- **THEN** only that frame reloads

#### Scenario: Refresh all
- **WHEN** the user refreshes all
- **THEN** every mounted frame reloads and no tab is closed

#### Scenario: Close all with more than one open
- **WHEN** the user closes all while two or more frames are mounted
- **THEN** confirmation is required first, stating how many will close

#### Scenario: Nothing reloads by itself
- **WHEN** the portal re-renders, the theme changes, the search query changes, or a set is opened
- **THEN** no mounted frame reloads

### Requirement: Focus mode gives the viewport to the embedded app
A focus mode SHALL hide the portal's own chrome while keeping the tab strip, and SHALL be reversible from the keyboard.

#### Scenario: Entering and leaving
- **WHEN** the user enters focus mode and then presses Escape
- **THEN** the chrome returns, the same tab is still focused, and no frame has reloaded

### Requirement: Which tabs were open is remembered, their contents are not
The set of open embedded items SHALL be remembered per browser and restored on load, as a fresh mount.

#### Scenario: Reload the portal
- **WHEN** the user reloads the page with two embedded tabs open
- **THEN** both tabs reappear, mounted from scratch, and the portal does not imply their previous state survived

#### Scenario: Remembered item no longer exists
- **WHEN** a remembered embedded item has been removed from the config
- **THEN** its tab is not restored and the stored entry is discarded silently
