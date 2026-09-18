import { collectInventory, generateLocalModelJson, listDir, readFile, searchPlace, writeRootViewFiles, writeViewFiles } from "./subject";
import { parseView } from "./viewSanitize";
import type { BuildIo } from "./viewBuild";
import type { RootBuildIo } from "./rootBuild";

/** One explicit Raven run. Check both sides of every asynchronous step;
 * native session checks also reject commands delayed across a root switch.
 * An already running read uses its captured directory handle. An already
 * submitted pair write commits under the native root transition lock.
 */
export function viewIoForSession(session: number, isCurrent: () => boolean): BuildIo & RootBuildIo {
  const check = () => { if (!isCurrent()) throw new Error("the alabs root changed while the view was being built"); };
  const guard = <Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) => async (...args: Args): Promise<Result> => {
    check();
    const result = await operation(...args);
    check();
    return result;
  };
  return {
    collectInventory: guard((place) => collectInventory(place, session)),
    listDir: guard((path) => listDir(path, session)),
    readFile: guard((path) => readFile(path, session)),
    search: guard((query, scope) => searchPlace(query, scope, session)),
    generate: guard((model, system, prompt) => generateLocalModelJson(model, system, prompt, session)),
    writeViewFiles: guard((place, root, facts, svg, replace) => writeViewFiles(place, root, facts, svg, replace, session)),
    writeRootViewFiles: guard((root, facts, svg, replace) => writeRootViewFiles(root, facts, svg, replace, session)),
    checkSvg: (svg) => {
      check();
      const parsed = parseView(svg);
      return parsed.kind === "ok" ? { kind: "ok", landmarks: parsed.landmarks.length } : { kind: "invalid", reason: parsed.reason };
    },
  };
}
