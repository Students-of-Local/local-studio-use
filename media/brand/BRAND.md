# Local Studio browser and computer tools: brand

These are Local Studio's hands: you send the work and it carries it out on your computer and in
your browser. The brand should feel calm and capable, with the human in command. It is not an
"autonomous AI agent".

The extension and helper are part of Local Studio, so they use its colors and draw their mark the
way the desktop app draws its own: a disc built from circles, with a shape cut out of it.

## Mark

A pointer cut out of a disc. The pointer says browser use and computer use; the disc ties it to
Local Studio's mark. The pointer's corners are rounded with arcs so it reads at small sizes.

`build.mjs` draws every mark and icon from one polygon (`POINTER`, on a 1024 grid) and one palette
(`PALETTE`). Don't edit its outputs by hand: change the script, run it, and look at what it wrote.

| File | Use |
| --- | --- |
| `icon.svg` | The icon on a 64 grid, in Local Studio's glass gradient. 32 px and up. |
| `icon-16.svg` | 16 px icon, flat `#346bf1`, with a bigger pointer so it still reads. |
| `mark.svg` | One-color mark in ink `#27272a`, for light backgrounds. |
| `mark-blue.svg` | One-color mark in `#346bf1`. |
| `icon-macos.svg`, `icon-macos-dark.svg` | The Mac app icon: the mark on Local Studio's light and dark tiles. |

`build.mjs` also writes:

- `TYCHICUS_ICON`, `TYCHICUS_ICON_16` and `TYCHICUS_MARK` (`currentColor`) in `src/components/tychicus-svg.ts`;
- `static/icon-{16,32,48,128}.png`, `hero.png`, `hero-light.png`, `social.png` rendered with Playwright.

Run `node media/brand/build.mjs` (add `--svg` to skip the PNGs). When Playwright's own browser isn't
downloaded, point `TYCHICUS_CHROMIUM` at any Chromium. `test/tychicus-logo.test.mjs` fails when a copy
drifts from these files, a PNG isn't the size it claims, or an old color comes back.

Rules:

- Keep the mark one shape: no outlines, shadows or added symbols on it.
- Don't rotate it. The pointer always points up and to the left.
- Don't put it in Polycarp's olive or the old helm's brass. Never pair it with the Sitegeist orb,
  badlogic's marks or Polycarp's helm; Local Studio credits them in words, not in pictures.

## Palette

Local Studio's colors. Text pairs are checked against WCAG AA (4.5:1).

| Name | Hex | Use |
| --- | --- | --- |
| Glass light | `#b6c8ff` | Top of the icon gradient. Never text. |
| Glass | `#5b84ff` | Middle of the gradient; accent text on dark (5.57:1 on `#111`). |
| Glass deep | `#2a3fe0` | Bottom of the gradient; edges and rings. |
| Blue | `#1b4ed8` | Accent and links on light (6.71:1 on white). The side panel's `--tk-brass`. |
| Blue bright | `#346bf1` | Buttons on dark, with white text (4.65:1). Not body text on dark (4.06:1 on `#111`). |
| Blue text dark | `#7c9cff` | Accent text and rings on dark (7.24:1 on `#111`). |
| Ink | `#27272a` | Body text on light. |
| Muted | `#71717b` | Secondary text on light (4.71:1 on `#fcfcfc`). The side panel uses `#6d6d77`, which also reaches 4.65:1 on its gray `#f4f4f4` fill. |
| Canvas | `#fcfcfc` / `#0a0a0a` | Page background, light and dark. |
| Surface | `#ffffff` / `#111111` | Panels and cards, light and dark. |
| Border | `#e4e4e7` / `#27272a` | Lines, light and dark. |

The Mac tiles go from `#ffffff` to `#e9edf5` (light) and from `#24252c` to `#0b0b0e` (dark). The side
panel's default preset (`tabkyra` in `src/appearance/palettes.ts`) and the fallbacks in `src/app.css`
use these values; `tokens.ts` lifts accent text to 4.5:1 when a user picks another accent.

## Type

| Role | Face | Where |
| --- | --- | --- |
| Text and wordmark | Instrument Sans, semibold for the wordmark | Site and hero |
| Code | JetBrains Mono | Commands, the CLI in screenshots |
| Extension UI | System UI stack | The side panel bundles no fonts |

Both fonts are OFL-licensed and come from `@fontsource` packages: `npm install --no-save --prefix media/brand @fontsource/instrument-sans @fontsource/instrument-serif @fontsource/jetbrains-mono`
before drawing the cards.

The wordmark is "Local Studio", two words, set in Instrument Sans semibold at -0.035em
tracking. Write the name as Local Studio in prose; the command is `tychicus` until it is renamed.

## Voice

Plain, direct American English. Say what the tool does and what the user controls. Avoid
hype, "AI-powered", "autonomous" and "seamless". Safety statements are concrete: name
what is blocked and who approves.
