/** Monaco language ids keyed by lowercase file extension (or full filename). */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  md: "markdown",
  markdown: "markdown",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  txt: "plaintext",
  dockerfile: "dockerfile",
  makefile: "plaintext",
};

/** A language suggested by the name, or null when the name tells us nothing. */
export function knownLanguageForFile(name: string): string | null {
  const lower = name.toLowerCase();
  if (LANGUAGE_BY_EXTENSION[lower]) return LANGUAGE_BY_EXTENSION[lower];
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  return LANGUAGE_BY_EXTENSION[lower.slice(dot + 1)] ?? null;
}

/** Monaco can edit readable unknown files as plain text; this is not a file-kind claim. */
export function languageForFile(name: string): string {
  return knownLanguageForFile(name) ?? "plaintext";
}
