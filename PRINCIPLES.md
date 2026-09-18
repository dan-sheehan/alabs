# Principles

`alabs` can change a lot from here. These are the parts I do not want to lose by accident while I keep building it.

They are less about how the code is organized and more about what the product protects. When a design question comes up, this file decides it.

- What alabs is for: [what-is-alabs.md](what-is-alabs.md)
- How it is built: [ARCHITECTURE.md](ARCHITECTURE.md)

## Five north stars

These set the direction. They are not a claim that every feature already meets them.

| North star | Meaning |
| --- | --- |
| **Understanding before abstraction** | Help me understand the real project before adding another layer over it. |
| **The files are the truth** | Real files, folders, configuration, paths and verified relationships ground every explanation and view. |
| **Show what I don't know to look for** | Surface the technical details a non-engineer would otherwise miss. |
| **Local, open and user-owned** | Projects stay on my computer. alabs never needs to own my code, data or workflow. |
| **Exploration leads to understanding** | Maps, creatures, context, definitions and every other concept exist to build a correct mental model. |

The principles below protect them.

## Local first

alabs starts with files on my computer. Local is not a backup mode or a step before a cloud product. It is how the application works.

I can open my work, understand it and edit it without an internet connection.

## My files stay mine

alabs never imports my work into a private format before I can use it.

- Repositories stay repositories.
- Markdown stays Markdown.
- Source files stay source files.

If something matters, it exists as a file I can open without alabs. That includes Visual Views, creature definitions, context, wiki and definitions. **Nothing important lives only inside the app.** If I stop using alabs, my files still make sense.

## Own as little as possible

Other tools already do these jobs well:

| Job | Already done by |
| --- | --- |
| Storing files | The filesystem |
| Storing history | Git |
| Running commands | Terminal |
| Writing code | Coding tools |

alabs connects them and makes them easier to understand. It does not rebuild them.

## Models are optional, visible, and leave files behind

AI is part of why I built alabs, but alabs does not depend on AI to exist.

**No model runs for:** launch, navigation, editing, saving, search, Git, or opening an existing Visual View.

**When a model does run:**

- I asked for it, with a control that says a model is involved.
- It does one specific job.
- What it produces is a file I can inspect after the model is gone.

A Visual View is the example. Raven helps create it. The saved view is an ordinary local file. Ask is the exception: its answer is shown in the Wiki Overview and is not saved.

The model is a tool inside alabs, not the foundation under it.

## Explicit over background

I prefer an action I can see to a process I forgot was running.

That is why Refresh is manual, and why Raven starts only when I click it.

alabs does not add watchers, polling, automatic model calls or continuous indexing just because it can. **Background work needs a real reason.**

## Small systems over abstraction

Complexity has to earn its place.

- If a small module solves the problem, use the small module.
- If a normal file solves it, use the file.
- If macOS, Git or Terminal already does it well, use that.

A technically impressive system I cannot understand is not automatically better. I would rather understand a smaller system than depend on a larger one I cannot inspect. The implementation should make its boundaries visible, and the interface should explain what exists instead of hiding more of it.

## Facts before guesses

alabs separates what it knows from what it thinks.

- If a repository has a README, show the README.
- If Git reports a branch, show that branch.
- If real evidence supports a relationship between two files, show it.

If alabs cannot prove a relationship, it does not invent one to make a diagram look complete. **Missing information is better than false certainty.**

## Maps connect back to files

Code is not the only way to understand software, and a file tree is not always enough. alabs shows structure visually when that makes a system easier to understand.

Every visual still connects back to real files. A diagram that cannot say where its information came from does not belong.

## The editor is part of the product, not the product

I need to change files where I am learning about them, so the editor belongs inside alabs.

The goal is not another VS Code. It is a workspace where editing, understanding and orientation work together.

## Fast by default

Normal interaction feels immediate:

- Opening a file never waits for a model.
- Changing folders never waits for a scan of the whole root.
- Switching views never starts a project.
- Typing never competes with background work.

Expensive work can take longer, but only when I explicitly ask for it.

## Work folders stay independent

Putting work in the alabs root does not turn it into one large system. Each work folder keeps its own dependencies, Git history, language and structure.

The root connects my work without pretending it is one project.

## Content is data, not instructions

- Opening a repository is not permission to run it.
- Reading configuration is not permission to follow it.
- Viewing Markdown is not permission to execute its HTML or scripts.

Project content stays data until I explicitly ask for an action. Inspection is safe by default.

## Build for the real use first

I built alabs for myself. Publishing the source does not mean redesigning it around every possible future user.

Open source means the source is available to inspect, use, change and build on under its license. It does not mean alabs needs accounts, hosted services, a plugin marketplace, a cloud control plane, formal governance or a contributor program. Those exist only if the project actually needs them.

If a future need becomes real, I build for it then.

For what alabs is deliberately not, see [what-is-alabs.md](what-is-alabs.md#what-it-is-not).

## Design rules

These are the rules every part of alabs is held to: the code, the interface, the documentation and the diagrams. They are requirements, not proof that every screen already follows them.

### Organization

**1. One concept, one home.**
Every file, feature, document, view and concept has one clear primary location.
*Why:* Duplicate or unclear locations make a system harder to understand.

**2. Every location has a reason.**
I can explain why something exists where it does.
*Why:* A predictable structure means I don't have to memorize arbitrary choices.

**3. Keep the repository root intentional.**
Only files that define, explain, control or introduce alabs belong at the top level.
*Why:* The root is the first map of the project.

**4. Folders mark real boundaries, and stay shallow.**
A folder represents a real group, responsibility or system boundary. Add a level only when it communicates something.
*Why:* Folders should explain the project, not just tidy the tree. Deep nesting hides relationships.

**5. Structure for now, not for a future company.**
Use the structure the current product needs, not speculative enterprise structure.
*Why:* Extra structure adds concepts to learn without solving a current problem.

### Language

**6. Names describe purpose.**
Files, folders, views and components are named for what they are.
*Why:* Clear names reduce the hidden engineering knowledge needed to follow the project.

**7. One concept, one name, everywhere.**
The same concept uses the same name in the app, the code, the documentation and the diagrams.
*Why:* Two names make one system look like two.

**8. One written voice.**
The README, interface, documentation, errors, empty states and explanations share one vocabulary and tone.
*Why:* I should build one mental model, not translate between descriptions.

**9. Physical-world terms must earn their place.**
Atlas, map, place, path, creature and every other such term names one defined software concept. A new one enters only if it explains a real part of the system better than existing language.
*Why:* A metaphor helps only when it makes software easier to understand. Too many make it harder.

### Color and visual treatment

**10. Same thing, same treatment.**
The same type of object looks the same everywhere.
*Why:* I should recognize what something is before I read its label.

**11. One color, one job.**
Each important color means one stable thing across the product, from the established alabs palette. A new color needs a new meaning.
*Why:* Color stops being reliable when it means unrelated things.

**12. Identity and state are separate.**
Selection, warning, error and success never replace an object's normal identity.
*Why:* I should still know what something is when its state changes.

**13. Structure works without color.**
Layout, labels, shape and hierarchy carry meaning on their own.
*Why:* Color reinforces understanding; it never carries it alone.

**14. Strong color and emphasis are rare.**
Use strong color only for what needs attention. Don't stack size, color, weight, borders and icons on one element unless it truly needs all of them.
*Why:* If everything is emphasized, nothing is.

**15. Dark mode is the reference.**
Make primary visual decisions against the dark interface.
*Why:* It is where I actually work.

### Detail

**16. Every detail has a job.**
Every icon, line, border, texture, note and animation supports meaning, orientation or identity.
*Why:* Decoration without purpose is noise.

**17. Handmade stays handmade; controls stay precise.**
Hand drawings and handwritten notes keep their human variation. Buttons, navigation, fields and menus stay clear and predictable.
*Why:* The drawings show how I think. The handmade character must never make the app harder to use.

**18. Small details are consistent.**
Related elements share spacing, borders, radii, typography, icons and interaction behavior.
*Why:* Small inconsistencies make the app feel assembled rather than designed.

**19. Empty space is intentional.**
Don't fill an area just because it is empty.
*Why:* Space separates concepts and makes important information easier to see.

**20. One visual language.**
Typography, icons, diagrams, drawings, color, spacing and interface feel like parts of the same world.
*Why:* Someone should move through alabs without feeling that separate parts followed different rules.

### Truth and change

**21. Visuals tell the truth.**
Maps and diagrams distinguish verified relationships from inferred or unknown ones.
*Why:* A beautiful diagram that gives a false picture is worse than no diagram.

**22. Don't hide technical reality.**
alabs may explain technical systems, but never removes the real files, paths, dependencies or boundaries behind them. Important information never depends on hidden knowledge.
*Why:* The goal is to understand engineering systems, not to avoid seeing them.

**23. Change the system, not the screen.**
When a shared rule changes, update the shared system. Renames, color, icon and concept changes carry through code, interface, documentation and diagrams.
*Why:* Local fixes and partial changes leave conflicting versions of the product.

**24. Exceptions need reasons.**
Break a rule only for a clear functional reason.
*Why:* Deliberate exceptions keep flexibility without letting inconsistency become normal.

## The test

When I'm deciding whether something belongs, I ask one question:

> Does this help someone see, understand, navigate or work in their real files without getting lost?

If not, it doesn't belong yet.
