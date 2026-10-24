## 1. Fix

- [x] 1.1 Introduce `--icon-size` on `.icon` and size the box from it
- [x] 1.2 Remove `width` and `height` from `.icon-img`, which is the box rather than something inside it
- [x] 1.3 Convert the group-heading and tab overrides to set `--icon-size`

## 2. Guard

- [x] 2.1 Add a CI invariant that fails if any `.icon-*` variant declares its own width or height
- [x] 2.2 Prove the guard catches the original bug when it is reintroduced

## 3. Verification

- [x] 3.1 Render a config shaped like a real deployment: emoji on groups, favicon URLs on items, one item with no icon
- [x] 3.2 Confirm every icon is the same size, names stay on one line, and cards are uniform height
- [x] 3.3 Confirm a 16px source, a 32px source and an SVG all render at the box size
- [x] 3.4 Confirm group and tab icons are still smaller
