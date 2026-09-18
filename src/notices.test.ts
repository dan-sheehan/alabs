import { describe, expect, it } from "vitest";
import {
  copyFailedNotice,
  failureNotice,
  isTaskBlockedNotice,
  NEVER_ON_SCREEN,
  outsidePlaceNotice,
  placeMissingNotice,
  refreshNotice,
  roleConflictText,
  rootOpenNotice,
  stateFallbackNotice,
  summaryNotice,
  taskBlockedNotice,
  taskCopiedNotice,
  terminalFailedNotice,
  tooManyOpenFilesNotice,
} from "./notices";

const samples = [
  rootOpenNotice("/Users/me/alabs", "cannot open /Users/me/alabs: No such file or directory (os error 2)"),
  rootOpenNotice("/Users/me/file.txt", "not a folder: /Users/me/file.txt"),
  rootOpenNotice("/Users/me/Library/Application Support/me.dannysheehan.alabs", "cannot open x: it overlaps the alabs application data folder (y)"),
  failureNotice("path is outside the subject: ../secret.txt"),
  failureNotice("already exists: defiance"),
  failureNotice("cannot access x: No such file or directory (os error 2)"),
  failureNotice("no subject is open"),
  stateFallbackNotice("saved layout is version 1, this alabs uses version 2"),
  summaryNotice("Refresh: nothing changed."),
  failureNotice("path is outside the scope defiance: cockpit/a.txt"),
  outsidePlaceNotice("defiance"),
  tooManyOpenFilesNotice(),
  placeMissingNotice("defiance", "/Users/me/alabs"),
  refreshNotice({ changed: 2, missing: 1, failed: 0, places: 3 }),
  refreshNotice({ changed: 0, missing: 0, failed: 0, places: 0 }),
  refreshNotice({ changed: 1, missing: 0, failed: 2, places: 1 }),
  summaryNotice(roleConflictText("Context", ["Context", "context"])),
  taskCopiedNotice(3),
  taskCopiedNotice(1),
  taskBlockedNotice("defiance/src/corpus.py"),
  copyFailedNotice("NotAllowedError: clipboard"),
  terminalFailedNotice("defiance", "cannot start open: No such file"),
];

describe("notice boundary", () => {
  it("maps known Rust reasons to the design copy", () => {
    expect(samples[0].text).toBe("Could not open /Users/me/alabs: No such file or directory.");
    expect(samples[1].text).toBe("Could not open /Users/me/file.txt: not a folder.");
    expect(samples[2].text).toBe("This folder overlaps alabs' own settings folder. Choose another root.");
    expect(samples[3].text).toBe("This file is not inside any alabs place: ../secret.txt.");
    expect(samples[4].text).toBe("A folder named defiance already exists.");
    expect(samples[7].text).toBe("alabs could not read its saved layout, so it starts fresh. Your files are untouched.");
  });

  it("uses the Step 3 design copy for place, cap, missing and Refresh notices", () => {
    expect(samples[9].text).toBe("Destination is outside defiance. Use Finder, then Refresh.");
    expect(samples[9].log).toBe("path is outside the scope defiance: cockpit/a.txt");
    expect(samples[10].text).toBe("Destination is outside defiance. Use Finder, then Refresh.");
    expect(samples[11].text).toBe("Too many open files across places. Close some tabs and try again.");
    expect(samples[12].text).toBe(
      "defiance is not in /Users/me/alabs right now. Your open files and unsaved edits are still here. Put the folder back, then Refresh.",
    );
    expect(samples[13].text).toBe("Refresh: 2 files changed on disk, 1 missing, across 3 places.");
    expect(samples[14].text).toBe("Refresh: nothing changed.");
    expect(samples[15].text).toBe("Refresh: 1 file changed on disk, 2 could not be checked, across 1 place.");
    expect(samples[16].text).toBe("Two folders match Context: Context and context. Rename one in Finder, then Refresh.");
    expect(samples[13].error).toBe(false);
    expect(samples[11].error).toBe(true);
  });

  it("uses the Step 6 design copy for the task packet and Terminal notices", () => {
    expect(samples[17].text).toBe("Task packet copied · 3 context files");
    expect(samples[18].text).toBe("Task packet copied · 1 context file");
    expect(samples[17].error).toBe(false);
    expect(samples[19].text).toBe("Save defiance/src/corpus.py before copying the task packet.");
    expect(isTaskBlockedNotice(samples[19])).toBe(true);
    expect(isTaskBlockedNotice(samples[17])).toBe(false);
    expect(samples[20].text).toBe("Copy failed. Task packet shown for manual copy.");
    expect(samples[20].error).toBe(true);
    expect(samples[20].log).toContain("NotAllowedError");
    expect(samples[21].text).toBe("Unable to open Terminal for defiance.");
    expect(samples[21].error).toBe(true);
    expect(samples[21].log).toContain("cannot start open");
  });

  it("keeps the technical text for the log", () => {
    expect(samples[0].log).toContain("os error 2");
    expect(samples[3].log).toBe("path is outside the subject: ../secret.txt");
    expect(samples[7].log).toContain("version 1");
    expect(samples[8].log).toBeNull();
  });

  it("never shows the words DESIGN.md section 7 bans", () => {
    for (const notice of samples) {
      for (const word of NEVER_ON_SCREEN) {
        const shown = notice.text;
        const found = word === word.toUpperCase() ? shown.includes(word) : shown.toLowerCase().includes(word.toLowerCase());
        expect(found, `"${shown}" contains "${word}"`).toBe(false);
      }
    }
  });

  it("an unknown reason still shows plainly and is an error", () => {
    const unknown = failureNotice("cannot move a to b: Directory not empty (os error 66)");
    expect(unknown.text).toBe("cannot move a to b: Directory not empty.");
    expect(unknown.error).toBe(true);
    expect(summaryNotice("x").error).toBe(false);
  });
});
