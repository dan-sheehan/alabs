import { useEffect, useRef, useState } from "react";
import { log } from "./log";
import { askFailureText, buildAsk, type AskFolders, type AskIo } from "./localModel";
import { askLocalModel, listDir, listLocalModels, readFile, viewSession, type ModelListResult } from "./subject";

/** Every call the section makes, injectable for tests. Production uses the root-bounded bridge. */
export interface AskBridge extends AskIo {
  session: (root: string) => Promise<number>;
  listDir: typeof listDir;
  readFile: (path: string, session?: number) => Promise<{ content: string }>;
  listModels: () => Promise<ModelListResult>;
  ask: typeof askLocalModel;
}

const BRIDGE: AskBridge = { session: viewSession, listDir, readFile, listModels: listLocalModels, ask: askLocalModel };

/** What the section is given: the folders to read, the remembered model, and where a choice goes. */
export interface AskProps {
  rootPath: string;
  folders: AskFolders;
  /** The remembered selection from disposable state, or null when none is chosen. */
  model: string | null;
  /** A choice from the selector, or null to clear a selection Ollama no longer lists. */
  onSelectModel: (name: string | null) => void;
}

interface AskLocalModelProps extends AskProps {
  locked: boolean;
  bridge?: AskBridge;
}

type Phase =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "answer"; text: string; model: string; files: number }
  | { kind: "failure"; text: string };

/** What the last explicit listing of installed models found; `unknown` until one is asked for. */
type Models =
  | { kind: "unknown" }
  | { kind: "listing" }
  | { kind: "unavailable" }
  | { kind: "none" }
  | { kind: "models"; names: string[] }
  | { kind: "failed"; text: string };

/**
 * The `ASK LOCAL MODEL` section of the Wiki Overview (post-Stage-1
 * feature): one question box, one model choice and one Ask chip. Nothing
 * runs until the user acts: choosing lists what the local Ollama reports as
 * installed (never a catalog, never a download), Ask reads the saved
 * `context/` and `wiki/` files, sends the one bounded input with exactly the
 * chosen model and shows the answer here. The model is never picked for the
 * user; a remembered name Ollama no longer lists is cleared and asked for
 * again. The answer is disposable: it lives in this component's state only,
 * is never written to disk or to the layout file, and the Editor stays the
 * way Wiki files change. Only the failure kind is logged, never the input or
 * the answer. Navigation never waits: no lock is taken and a completion
 * that outlives a newer ask is dropped.
 */
export function AskLocalModel({ rootPath, folders, model, onSelectModel, locked, bridge = BRIDGE }: AskLocalModelProps) {
  const [question, setQuestion] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [models, setModels] = useState<Models>({ kind: "unknown" });
  const asks = useRef(0);
  const lifetime = useRef(0);
  useEffect(() => () => { lifetime.current += 1; asks.current += 1; }, [rootPath]);

  /** List what Ollama reports as installed, on the explicit choose, change or retry click. */
  const discover = async () => {
    const started = lifetime.current;
    setModels({ kind: "listing" });
    const result = await bridge.listModels();
    if (started !== lifetime.current) return;
    switch (result.kind) {
      case "models":
        if (model !== null && !result.names.includes(model)) onSelectModel(null);
        setModels(result.names.length === 0 ? { kind: "none" } : { kind: "models", names: result.names });
        return;
      case "unavailable":
        void log("warn", "local model: unavailable");
        setModels({ kind: "unavailable" });
        return;
      default:
        void log("warn", `local model list: ${result.kind}`);
        setModels({ kind: "failed", text: askFailureText(result) });
    }
  };

  const ask = async () => {
    if (model === null) return;
    const id = ++asks.current;
    const current = () => asks.current === id;
    setPhase({ kind: "thinking" });
    const settle = (next: Phase) => {
      if (asks.current === id) setPhase(next);
    };
    let input;
    let session: number;
    try {
      session = await bridge.session(rootPath);
      const check = () => { if (!current()) throw new Error("The alabs root changed."); };
      check();
      input = await buildAsk({
        listDir: async (path) => { check(); const value = await bridge.listDir(path, session); check(); return value; },
        readFile: async (path) => { check(); const value = await bridge.readFile(path, session); check(); return value; },
      }, folders, question);
    } catch (err) {
      if (!current()) return;
      void log("warn", "local model: material listing failed");
      settle({ kind: "failure", text: `Could not list the Context and Wiki files: ${String(err).replace(/\s*\(os error \d+\)/g, "")}.` });
      return;
    }
    if (!current()) return;
    if (input.kind !== "ready") {
      settle({ kind: "failure", text: askFailureText(input) });
      return;
    }
    const result = await bridge.ask(model, input.system, input.prompt, session);
    if (!current()) return;
    if (result.kind === "answer") {
      settle({ kind: "answer", text: result.text, model: result.model, files: input.files.length });
      return;
    }
    void log("warn", `local model: ${result.kind}`);
    if (result.kind === "not_installed") {
      onSelectModel(null);
      setModels({ kind: "unknown" });
    }
    settle({ kind: "failure", text: askFailureText(result) });
  };

  const thinking = phase.kind === "thinking";
  const retry = (
    <button type="button" className="navlink" onClick={() => void discover()} disabled={locked}>
      retry
    </button>
  );
  const choice = (() => {
    switch (models.kind) {
      case "listing":
        return <span className="muted ask-status">Finding local models…</span>;
      case "models":
        return (
          <>
            <select
              className="input ask-model"
              aria-label="Local model"
              value={model ?? ""}
              disabled={locked || thinking}
              onChange={(e) => onSelectModel(e.target.value === "" ? null : e.target.value)}
            >
              <option value="" disabled>
                Choose a local model…
              </option>
              {models.names.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {model === null && <span className="muted ask-status">Choose a local model.</span>}
          </>
        );
      case "unavailable":
        return (
          <span className="error ask-status" role="status">
            Local model unavailable. {retry}
          </span>
        );
      case "none":
        return (
          <span className="error ask-status" role="status">
            No local models available. {retry}
          </span>
        );
      case "failed":
        return (
          <span className="error ask-status" role="status">
            {models.text} {retry}
          </span>
        );
      case "unknown":
        return model !== null ? (
          <span className="ask-status">
            <span className="mono">{model}</span>{" "}
            <button type="button" className="navlink" onClick={() => void discover()} disabled={locked || thinking}>
              change
            </button>
          </span>
        ) : (
          <button type="button" className="navlink" onClick={() => void discover()} disabled={locked}>
            Choose a local model…
          </button>
        );
    }
  })();
  return (
    <section className="overview-section ask" aria-label="ASK LOCAL MODEL">
      <div className="overview-tag">
        <span className="tag">ASK LOCAL MODEL</span>
        <span className="tag tag-detail">reads the saved files in context/ and wiki/</span>
      </div>
      <textarea
        className="input ask-question"
        rows={3}
        spellCheck={false}
        value={question}
        disabled={locked}
        placeholder="What do I want to know?"
        onChange={(e) => setQuestion(e.target.value)}
      />
      <div className="overview-actions ask-actions">
        <button
          type="button"
          className="chip chip-primary"
          onClick={() => void ask()}
          disabled={locked || thinking || model === null || question.trim().length === 0}
        >
          Ask
        </button>
        {thinking ? (
          <span className="muted ask-status" role="status">
            Thinking…
          </span>
        ) : (
          choice
        )}
      </div>
      {phase.kind === "answer" && (
        <div className="ask-answer-block">
          <div className="overview-tag ask-answer-tag">
            <span className="tag">ANSWER</span>
            <span className="tag tag-detail">
              {phase.model} · {phase.files} {phase.files === 1 ? "file" : "files"} read · not saved
            </span>
          </div>
          <div className="ask-answer">{phase.text}</div>
        </div>
      )}
      {phase.kind === "failure" && (
        <div className="error ask-failure" role="status">
          {phase.text}
        </div>
      )}
    </section>
  );
}
