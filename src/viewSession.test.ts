import { expect, it, vi, beforeEach } from "vitest";
import { viewIoForSession } from "./viewSession";
import * as bridge from "./subject";
vi.mock("./subject", () => ({
  collectInventory: vi.fn(), listDir: vi.fn(), readFile: vi.fn(), searchPlace: vi.fn(),
  generateLocalModelJson: vi.fn(), writeRootViewFiles: vi.fn(), writeViewFiles: vi.fn(),
}));
vi.mock("./viewSanitize", () => ({ parseView: vi.fn(() => ({ kind: "ok", landmarks: [] })) }));
beforeEach(() => vi.clearAllMocks());
it("passes the native session to every evidence and output operation", async () => {
  const io = viewIoForSession(17, () => true);
  await io.collectInventory("work"); await io.listDir("work"); await io.readFile("work/file.txt");
  await io.search("query", "work");
  await io.generate("local", "instruction", "fixture");
  await io.writeViewFiles("work", "/root", "facts", "svg", true);
  await io.writeRootViewFiles("/root", "facts", "svg", true);
  expect(bridge.generateLocalModelJson).toHaveBeenCalledWith("local", "instruction", "fixture", 17);
  expect(bridge.collectInventory).toHaveBeenCalledWith("work", 17);
  expect(bridge.listDir).toHaveBeenCalledWith("work", 17);
  expect(bridge.readFile).toHaveBeenCalledWith("work/file.txt", 17);
  expect(bridge.searchPlace).toHaveBeenCalledWith("query", "work", 17);
  expect(bridge.writeViewFiles).toHaveBeenCalledWith("work", "/root", "facts", "svg", true, 17);
  expect(bridge.writeRootViewFiles).toHaveBeenCalledWith("/root", "facts", "svg", true, 17);
});
it.each(["inventory", "listing", "read", "search", "model", "write", "root write"])("invalidates a pending %s result and forbids following operations", async (phase) => {
  let current = true;
  let release!: (value: never) => void;
  const pending = new Promise<never>((resolve) => { release = resolve; });
  const io = viewIoForSession(1, () => current);
  const operations = {
    inventory: () => { vi.mocked(bridge.collectInventory).mockReturnValueOnce(pending); return io.collectInventory("work"); },
    listing: () => { vi.mocked(bridge.listDir).mockReturnValueOnce(pending); return io.listDir("work"); },
    read: () => { vi.mocked(bridge.readFile).mockReturnValueOnce(pending); return io.readFile("work/file"); },
    search: () => { vi.mocked(bridge.searchPlace).mockReturnValueOnce(pending); return io.search("q", "work"); },
    model: () => { vi.mocked(bridge.generateLocalModelJson).mockReturnValueOnce(pending); return io.generate("local", "instruction", "fixture"); },
    write: () => { vi.mocked(bridge.writeViewFiles).mockReturnValueOnce(pending); return io.writeViewFiles("work", "/root", "facts", "svg", true); },
    "root write": () => { vi.mocked(bridge.writeRootViewFiles).mockReturnValueOnce(pending); return io.writeRootViewFiles("/root", "facts", "svg", true); },
  };
  const result = operations[phase as keyof typeof operations]();
  const rejected = expect(result).rejects.toThrow("root changed");
  current = false; release(undefined as never); await rejected;
  vi.clearAllMocks();
  await expect(io.readFile("work/new")).rejects.toThrow("root changed");
  await expect(io.generate("local", "instruction", "fixture")).rejects.toThrow("root changed");
  await expect(io.writeViewFiles("work", "/root", "facts", "svg", true)).rejects.toThrow("root changed");
  expect(() => io.checkSvg("svg")).toThrow("root changed");
  expect(bridge.readFile).not.toHaveBeenCalled();
  expect(bridge.generateLocalModelJson).not.toHaveBeenCalled();
  expect(bridge.writeViewFiles).not.toHaveBeenCalled();
});
