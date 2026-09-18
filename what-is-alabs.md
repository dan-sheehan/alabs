# What alabs is

AI coding tools make it possible to build working software without understanding the environment around it: configuration, paths, Git, dependencies, build output, generated files and security-relevant files. The software works, but the builder cannot say why, cannot tell what matters, and does not know what to look for.

Most developer tools assume you already know what you are looking for. An editor shows the file you chose. A terminal runs the command you typed. Neither tells you what exists, how it connects, or what you missed.

---

- [Who it is for](#who-it-is-for)
- [What it is](#what-it-is)
- [What it is not](#what-it-is-not)
- [How the workspace is organized](#how-the-workspace-is-organized)
- [Vocabulary](#vocabulary)
- [What must remain true](#what-must-remain-true)
- [Does a feature belong?](#does-a-feature-belong)


---

- [How it works](ARCHITECTURE.md)
- [Design decision rules](PRINCIPLES.md)
- [How it looks and reads](docs/design.md)

---

## Who it is for

alabs is built for people who build software using AI tools but don't come from an engineering background.

This is for you if you have a working project and want the answers to:

- What is this, and what actually exists here?
- How do the parts connect, and what matters?
- What should I understand before I change something?

alabs file and editing workflows don't need AI, and an engineer can use this as a workspace.

## What it is

alabs is a local macOS workspace over one chosen root folder. It allows you to:

- **see** what is in your work;
- **understand** it through facts and checked maps;
- **navigate** to the real files behind any explanation;
- **work** on those files in the same place, or hand the work to another coding tool and come back.

The files are the lasting system, and alabs is the application you use with them. If alabs disappeared tomorrow, all meaningful work would still exist as ordinary files, including the maps.

## What it is not

- It is not a coding tutor, a simplified IDE or a no-code builder.
- It does not replace Claude Code, Codex, Terminal or Git. alabs prepares work for those tools and shows the result, but it does not re-implement them.
- It is not a cloud product, a team product or enterprise software. There are no accounts, no sync, no telemetry and no hosted backend.
- It is not an agent platform. There is one creature, it does one job, and it runs only when asked.
- It does not run your projects. Opening a repository never executes, installs or builds anything in it.
- It does not replace engineering knowledge. It makes the environment visible, but it does not make understanding unnecessary.

## How the workspace is organized

```text
alabs root/                you choose this; it is the boundary
├── < work folder >/         any repository or folder, fully independent
├── < work folder >/
├── context/               what you supply to current work
├── wiki/                  outside knowledge worth keeping
├── definitions/           the legend: one term per file
└── views/                 saved maps, one folder per work folder
    └── .root/             the map of the whole root, shown on Home
```

Work enters alabs by being placed or cloned into the root. alabs does not reach into folders elsewhere on the machine. Each work folder keeps its own files, Git history, dependencies and structure. The root is not a repository and is never converted into a project format.

## Vocabulary

Each term names one real thing. The full glossary is in [definitions/](definitions/README.md).

| Term | Meaning |
| --- | --- |
| **alabs root** | The one folder you choose. Project file access stays inside it; app state and Chrome recovery drafts live in the app data folder. |
| **Work folder** | Any folder directly inside the root, except the knowledge folders, `views/` and dot-folders. |
| **Knowledge folders** | `context/`, `wiki/` and `definitions/`. They stay in reach whichever work folder is open. |
| **Context** | What you deliberately give the current work: facts about you or the task. |
| **Wiki** | Outside knowledge worth keeping. It is not project documentation. |
| **Definitions** | The legend: technical terms and alabs's own words, one Markdown file each. |
| **Atlas** | Everything alabs knows about your environment: the knowledge folders plus the maps. |
| **Visual View** | A saved map of one work folder, stored as `views/<folder>/map.svg` and `view.json`. |
| **Landmark** | A box on a map that points to one or more real files. |
| **Creature** | A named job done by a local model, using only what alabs can already do. |
| **Raven** | The only creature. It builds or rebuilds a Visual View. |
| **Refresh** | The button that tells alabs to look at the disk again. Nothing else does. |

Engineers reading the code: a work folder is called a *place* there.

## What must remain true

These rules define alabs. Breaking one does not add a feature. It makes a different product.

1. **One root, independent work folders.** alabs works inside one folder you chose. It never merges, moves or reformats the work inside it.
2. **Files are the source of truth.** Maps are files. Knowledge is files. Nothing important lives only inside the app.
3. **Normal use needs no model and no network.** Browsing, editing, Markdown, search, Git and existing maps all work offline.
4. **Model work is explicit and local.** A model runs only when you click something that says so. It runs on your machine through Ollama. Raven saves maps as files you can read; Ask displays an answer without saving it.
5. **Maps tell the truth.** A map shows only what a real file supports. If something is unknown, the map says so.
6. **Project content is data.** Reading a repository never runs it.
7. **alabs never acts behind your back.** There are no watchers, no background indexing, no scheduled creatures and no automatic rebuilds.
8. **Normal work is fast.** Opening, editing and saving never wait on a model, a scan of the whole root or a project starting up.

## Does a feature belong?

Ask one question: *does this help someone see, understand, navigate or work in their real files without getting lost?*

If yes, check it against the rules above and [PRINCIPLES.md](PRINCIPLES.md).

These stay out unless real use proves they are needed:

- a plugin system;
- an embedded coding agent;
- automatic execution or dependency installation;
- support for every file type;
- permission systems.
