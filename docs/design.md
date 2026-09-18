# Design

How alabs looks and reads: the interface, the maps and the documentation.
[PRINCIPLES.md](../PRINCIPLES.md) decides *whether* something belongs in
alabs; this document decides how it is presented. The colour tokens here are
defined in `:root` in `src/App.css`; if they differ, the CSS is right and
this table is a bug.

## The reference

alabs looks like a flat, dark technical map. Think of a surveyor's drawing, not a SaaS dashboard: thin lines, dense information, monospace readouts, and very little decoration. Cards with shadows, gradients and ornamental icons are out.

Dark mode is the reference. Primary decisions are made against the dark interface.

## Colour

Colour carries **state and kind**, never decoration. The palette is defined once, in `:root` in `src/App.css`.

| Token | Value | Job |
| --- | --- | --- |
| `--bg` | `#1b1b1b` | Background |
| `--hover`, `--sel` | `#222222`, `#232323` | Hover and selection surfaces |
| `--line`, `--border`, `--line-strong` | `#2c2c2c`, `#363636`, `#4a4a4a` | Hairlines, from faint to firm |
| `--text`, `--strong`, `--muted`, `--dim` | `#d6d6d6`, `#ffffff`, `#8c8c8c`, `#5f5f5f` | Text, from emphasis down to background detail |
| `--pos` | `#4ea1ff` | Where you are: position and selection |
| `--git` | `#3fbfa0` | Git state |
| `--folder` | `#9a9a9a` | Work folders |
| `--know` | `#9d8cff` | Knowledge folders |
| `--dirty` | `#e2c08d` | Unsaved or changed |
| `--error` | `#f48771` | Failure |

Rules:

1. **One colour, one job.** Never reuse a semantic colour for an unrelated meaning.
2. **Identity and state are separate.** Selection, warning and error must not replace what makes an object recognisable.
3. **Meaning survives without colour.** Layout, labels, shape and hierarchy must carry the meaning on their own; colour reinforces it.
4. **Strong colour is rare.** If everything is emphasised, nothing is.
5. **New colours need a new meaning.** Add a token only for a new semantic job, and add it to this table.

## Type

- **UI font:** the system sans (`--font-ui`).
- **Monospace** (`--font-mono`) is for anything that is a literal from the system: paths, file names, Git refs, counts, readouts.

Emphasise something once. Do not combine large size, strong colour, heavy weight, a border and an icon unless the element truly needs all of them.

## Maps

- Maps use the same visual language as the interface: flat groups, hairline arrows, and labels that say what one part does to another.
- The application renderer draws every map. A saved map is never a hand-made illustration.
- A drawing never suggests more certainty than the facts behind it. Anything unverified is left out, not drawn faintly.
- Every landmark must lead to real files.

## Illustration and interface

- Hand-drawn artwork (the alabs character, chalk sketches, the wordmark) keeps its visible human variation. It explains ideas and is never mistaken for a screenshot or a spec.
- Controls stay precise and predictable. The handmade character of the artwork never makes a button harder to use.
- The robot is the alabs character. Raven is a bird.

## Layout

- Empty space is deliberate. Don't fill an area just because it is empty.
- The same kind of object gets the same treatment everywhere.
- Related elements share spacing, borders, radii, type and behaviour.
- When a shared rule changes, change it in the shared system (the tokens, the shared components), not on one screen.

## Words

- One voice across the interface, errors, empty states and documentation: plain, factual and short.
- Say what happened and what to do. For example: `Local model unavailable.` and `Root view needs rebuild.`
- One name per concept, everywhere. The vocabulary lives in [what-is-alabs.md](../what-is-alabs.md#vocabulary) and [definitions/](../definitions/README.md).
- A metaphor (atlas, map, landmark, creature) enters only if it names a real software concept better than plain words do.

## Repository organisation

- One concept has one home. Duplicate locations make a system harder to read.
- Folders mark real boundaries, and nesting stays shallow.
- The repository root holds only what defines, explains or controls alabs.
- A rename, colour change or concept change is not done until it is consistent across code, interface, documentation and maps.
- Break a rule here only for a stated functional reason.
