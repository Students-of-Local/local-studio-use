# Brand

The mark is one ember with two drops pulling away from it: a thread and the subagents it fans out, still joined while they work. While Local Studio works, the drops orbit the core, split off and flow back in. At rest the mark holds the shape in `mark.svg`.

<p align="center"><img src="mark.svg" width="160" alt="The Local Studio mark: a large amber drop joined to two smaller drops"></p>

## Files

| File | Use |
| --- | --- |
| `mark.svg` | Full color mark on any background |
| `mark-mono.svg` | One color (`currentColor`), for small monochrome places |

`media/brand/build.mjs` copies both into the extension and renders its icons from them, so a change to the shape changes all of them together.

## Color

| Role | Dark | Light |
| --- | --- | --- |
| Canvas | `#120C0F` ink | `#FBF6EE` cream |
| Surface | `#1F151A` | `#FFFDF9` |
| Accent | `#DC6F42` amber | `#B8512A` burnt amber |
| Gold (warning, cursor) | `#F4C76E` | `#B86E00` |
| Wine (second glow) | `#E06690` | `#A8345F` |
| Text | `#F3EBDD` | `#1F1418` |

The mark's own fill runs from gold `#FFF4D6` through amber `#E58A4E` to wine `#7A2448`, and is the same in both appearances.

## Motion

- The mark moves only while something runs (a turn, a tool, a page loading) and stops when it is done.
- Reduce Motion shows the mark at rest. A hidden or covered window stops the animation.
- The window glows faintly amber behind the composer, a little brighter while a thread works. It never moves.
- The composer gets an amber edge while its thread works.
