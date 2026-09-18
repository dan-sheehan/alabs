# Definitions

Definitions are the legend: short explanations of the words alabs uses and
of technical things you meet while working, such as a `.git` folder, a
`.DS_Store` file or a lockfile.

## Where alabs looks

alabs reads Definitions from a folder named `definitions` directly inside
the alabs root you open. It does not read this folder. You can copy it there
as a starting point.

In your root, use one Markdown file per term. A definition says what the
thing is, why it exists, and what to do or not do with it.

Home and the rail list it as a knowledge folder. No model reads it: Ask
reads only `context/` and `wiki/`, and Raven reads only the work folder it
maps.

## The physical-world glossary

alabs names parts of an engineering environment with words from the
physical world. Each word has one software meaning, and is used only where
it helps. The application's own terms (alabs root, work folder, Visual
View, Refresh) are defined in the
[vocabulary](../what-is-alabs.md#vocabulary). This table covers the wider
metaphor.

| Physical idea | alabs idea | Software meaning |
| --- | --- | --- |
| World | Engineering environment | Everything around the software being worked on |
| Territory | Project | The actual system being understood |
| Atlas | Atlas | The organized body of knowledge about the environment |
| Map | Map / Visual View | A factual view of part of the system |
| Place | Place | A repository, folder, file or other location |
| Path | Path | A relationship between places |
| Road | Dependency or reference | One part of the project leads to another |
| Route | Execution or data flow | The sequence something follows through the system |
| Boundary | System boundary | Where one responsibility ends and another begins |
| Landmark | Important file or component | Something that helps orientation |
| Address | File path | The exact location of something |
| Neighborhood | Folder or subsystem | A group of related places |
| City | Repository or application | A larger collection of connected parts |
| Infrastructure | Build and runtime systems | Supporting systems the software needs |
| Utility lines | APIs, events, data connections | Connections that move information |
| Blueprint | Architecture | The structural explanation of the system |
| Sign | Metadata or documentation | Information explaining what something is |
| Legend | Definitions | Vocabulary needed to read the map |
| History | Context | Why the environment became what it is |
| Explorer | Wiki | Knowledge that helps understand what you meet |
| Creature | Active system element | Something that performs work |
| Raven | Factual inspector | The creature that explores and reports what exists |

The glossary is broader than the application. Here a place can be any
location; in the application, a place is a work folder directly inside the
root.
