# Visual Views

This folder shows where `alabs` looks for Visual Views and what each one holds. What alabs is for: [what-is-alabs.md](../what-is-alabs.md)

A Visual View is a saved map of one work folder. Each landmark points to a real file, and each arrow is backed by a line in a real file. Opening a view never runs the project and needs no model.

## Layout in your root

alabs reads views from a folder named `views` directly inside the alabs root you open. It does not read this folder: this copy only shows the shape.

```text
views/
├── <work folder>/
│   ├── map.svg      the drawing; opens in any browser
│   └── view.json    the checked facts it was drawn from
└── .root/
    ├── map.svg      the map of the whole root, shown on Home
    └── view.json
```

| File | What it is |
| --- | --- |
| `map.svg` | The drawing. It opens in any browser, with or without alabs. |
| `view.json` | The checked facts the drawing was made from. |

The `.root` folder holds the map of the whole root, and Home shows it.
