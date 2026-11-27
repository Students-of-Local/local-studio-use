# The extension's brand

The extension and its helper are part of Local Studio and wear its mark, colors and voice. The mark, its colors and how
it moves are in [docs/brand](../../docs/brand/README.md); this page says only how the
extension draws them.

## Mark

`node media/brand/build.mjs` copies `docs/brand/mark.svg` and `mark-mono.svg` into `src/components/local-studio-svg.ts` and
renders `static/icon-{16,32,48,128}.png`. Add `--svg` to skip the PNGs. When Playwright's own browser isn't downloaded, point
`LOCAL_STUDIO_BROWSER_CHROMIUM` at any Chromium. Never edit those outputs by hand. `test/local-studio-logo.test.mjs`
fails when a copy drifts from `docs/brand`, or a PNG isn't the size it claims.

Draw the mark on the bare background: no tile, outline or shadow, and never rotated.

## Palette

The default preset (`standard` in `src/appearance/palettes.ts`) and the fallbacks in `src/app.css`. Text pairs reach WCAG AA
(4.5:1); `tokens.ts` darkens or lightens accent text when a person picks another accent.

| Role | Light | Dark |
| --- | --- | --- |
| Page | `#fbf6ee` | `#120c0f` |
| Card | `#fffdf9` | `#1f151a` |
| Quiet fill (a person's own message, chips) | `#f3eadd` | `#261a20` |
| Text | `#1f1418` | `#f3ebdd` |
| Muted text | `#76655f` | `#9e8d89` |
| Border | `#eadfd0` | `#2a1d23` |
| Accent, with the text on it | `#b8512a`, `#ffffff` | `#dc6f42`, `#120c0f` |
| Error | `#b3261e` | `#f26b6b` |
| Done | `#1e8a55` | `#70d194` |

The panel opens dark until the person picks light or Match system. It uses the system UI face and bundles no fonts.
While an agent's script runs in a page, the page's edge glows faintly amber. It never moves.

## Voice

Plain, direct American English. Say what the tool does and what the user controls. Avoid
hype, "AI-powered", "autonomous" and "seamless". Safety statements are concrete: name
what is blocked and who approves.
