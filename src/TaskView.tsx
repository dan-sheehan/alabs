import { useEffect, useRef } from "react";
import { copyBlocker, selectedContext, type ContextCandidate, type TaskDraft } from "./task";

interface TaskViewProps {
  placeName: string;
  draft: TaskDraft;
  /** Open file-backed tabs in this place and the knowledge places, in rail then strip order. */
  candidates: readonly ContextCandidate[];
  locked: boolean;
  /** Change the draft; the scope owns it. */
  onDraft: (update: (draft: TaskDraft) => TaskDraft) => void;
  /** `Copy task packet`: App builds the packet, copies it from this click and records the baseline. */
  onCopy: () => void;
  onTerminal: () => void;
}

/**
 * The Task tab (DESIGN.md 6.10): a bounded instruction, the open files to
 * hand over as context, constraints, and the two handoff actions. Draft
 * text lives in the scope record only: never on disk, never history. Copy
 * is disabled until the task has one non-space character and while any
 * ticked context file has unsaved edits; it never saves on the user's
 * behalf. After a failed copy the packet is shown selected for manual copy.
 */
export function TaskView({ placeName, draft, candidates, locked, onDraft, onCopy, onTerminal }: TaskViewProps) {
  const chosen = selectedContext(candidates, draft.selected);
  const blocker = copyBlocker(draft.text, chosen);
  const fallback = useRef<HTMLTextAreaElement | null>(null);

  // The packet shown for manual copy is selected as soon as it appears.
  useEffect(() => {
    if (draft.fallback !== null) fallback.current?.select();
  }, [draft.fallback]);

  const toggle = (relPath: string, on: boolean) =>
    onDraft((d) => {
      const selected = new Set(d.selected);
      if (on) selected.add(relPath);
      else selected.delete(relPath);
      return { ...d, selected };
    });

  return (
    <div className="task" aria-label={`Task for ${placeName}`}>
      <section className="overview-section" aria-label="TASK">
        <div className="overview-tag">
          <span className="tag">TASK</span>
        </div>
        <textarea
          className="input task-text"
          rows={6}
          spellCheck={false}
          value={draft.text}
          disabled={locked}
          placeholder={`What should the coding tool do in ${placeName}?`}
          onChange={(e) => {
            const text = e.target.value;
            onDraft((d) => ({ ...d, text }));
          }}
        />
      </section>
      <section className="overview-section" aria-label="CONTEXT FILES">
        <div className="overview-tag">
          <span className="tag">CONTEXT FILES</span>
          {candidates.length > 0 && (
            <span className="tag tag-detail">
              {chosen.length} of {candidates.length} ticked
            </span>
          )}
        </div>
        {candidates.length === 0 ? (
          <div className="muted">Open the files you want to include, then tick them here.</div>
        ) : (
          <div className="task-rows">
            {candidates.map((c) => {
              const ticked = draft.selected.has(c.relPath);
              return (
                <label key={c.relPath} className={"task-row" + (ticked ? " task-row-ticked" : "")} title={c.relPath}>
                  <input type="checkbox" checked={ticked} disabled={locked} onChange={(e) => toggle(c.relPath, e.target.checked)} />
                  <span className="mono task-path">
                    <span className="ltr">{c.relPath}</span>
                  </span>
                  {ticked && c.dirty && (
                    <span className="dirty-mark" aria-label="unsaved edits">
                      •
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </section>
      <section className="overview-section" aria-label="CONSTRAINTS">
        <div className="overview-tag">
          <span className="tag">CONSTRAINTS</span>
        </div>
        <textarea
          className="input task-constraints"
          rows={2}
          spellCheck={false}
          value={draft.constraints}
          disabled={locked}
          onChange={(e) => {
            const constraints = e.target.value;
            onDraft((d) => ({ ...d, constraints }));
          }}
        />
      </section>
      <div className="overview-actions task-actions">
        <button
          type="button"
          className="chip chip-primary"
          disabled={locked || blocker !== null}
          title={blocker?.kind === "dirty" ? `Save ${blocker.relPath} first` : blocker?.kind === "empty" ? "Write the task first" : undefined}
          onClick={onCopy}
        >
          Copy task packet
        </button>
        <button type="button" className="chip" disabled={locked} onClick={onTerminal}>
          Open in Terminal
        </button>
      </div>
      {draft.fallback !== null && (
        <section className="overview-section" aria-label="TASK PACKET">
          <div className="overview-tag">
            <span className="tag">TASK PACKET</span>
            <span className="tag tag-detail">for manual copy</span>
          </div>
          <textarea ref={fallback} className="input mono task-fallback" rows={12} readOnly spellCheck={false} value={draft.fallback} />
        </section>
      )}
    </div>
  );
}
