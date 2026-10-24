## MODIFIED Requirements

### Requirement: Icons degrade gracefully
An item icon MAY be text, a URL or `auto`, and a failure to load one MUST NOT leave a broken image. Every icon variant SHALL render at the same size for a given context, and SHALL NOT influence the layout of the item it belongs to.

#### Scenario: Icon fails to load
- **WHEN** an icon URL returns an error or times out
- **THEN** the item falls back to initials derived from its name, with no broken-image glyph

#### Scenario: Automatic icon
- **WHEN** an item sets `icon: auto`
- **THEN** the portal attempts the origin's favicon and falls back to initials on failure

#### Scenario: Every variant is the same size
- **WHEN** one item uses an emoji, another a URL and another falls back to initials
- **THEN** all three icons render at the same size, and each card lays out identically apart from its text

#### Scenario: An image icon does not resize its card
- **WHEN** an item's icon is a URL, whatever the source image's pixel dimensions
- **THEN** the icon is contained within the icon box, the item's name stays on one line, and the card is the same height as a card whose icon is an emoji

#### Scenario: Smaller contexts
- **WHEN** an icon is shown in a group heading or an open app's tab rather than on a card
- **THEN** it renders smaller there, and every variant follows that size
