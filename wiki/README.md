# Wiki

This folder shows where `alabs` looks for the Wiki and what Ask sends from it. What alabs is for: [what-is-alabs.md](../what-is-alabs.md)

The Wiki holds knowledge worth keeping that is not tied to one project: patterns, notes about tools and lessons from earlier work. It is outside knowledge, not project documentation and not a generated description of a project.

## Where alabs looks

alabs reads the Wiki from a folder named `wiki` directly inside the alabs root you open. It does not read this folder: this copy only shows the shape.

Use ordinary Markdown or text files. The folder may be empty or absent.

Home and the rail list the Wiki as a knowledge folder. It opens like any other folder, with no model. Raven never reads it.

## Ask

The Wiki Overview has `Ask local model`. When you click it:

- alabs reads the top-level `.md`, `.markdown` and `.txt` files of `wiki/` and `context/`. Subfolders and hidden files are skipped.
- **Those files together must fit in 24,000 characters.** Over that, nothing is sent, and alabs tells you the total.
- The files and your question, up to 2,000 characters, go to the Ollama model you picked at `127.0.0.1:11434`, and nowhere else.
- The answer is shown and not saved.

Every included file counts, a README like this one too. The limits are set in `src/localModel.ts`.

**Known limit:** a Wiki larger than 24,000 characters cannot be sent to Ask. alabs does not trim or pick files for you.
