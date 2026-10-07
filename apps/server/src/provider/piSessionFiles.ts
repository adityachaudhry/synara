/** Pi session-file paths carried in worker-era resume cursors. */


export function extractResumeSessionFile(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) {
    return resumeCursor;
  }
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const record = resumeCursor as Record<string, unknown>;
  for (const key of ["sessionFile", "sessionFilePath", "nativeHandle", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function extractLegacyPiResumeSessionFile(resumeCursor: unknown): string | undefined {
  const file = extractResumeSessionFile(resumeCursor);
  const prefix = "/root/.pi/agent/sessions/";
  return file?.startsWith(prefix) && file.endsWith(".jsonl") &&
    !/[\\\\\u0000]/u.test(file) && file.slice(prefix.length).split("/").every((part) => part && part !== "." && part !== "..")
    ? file : undefined;
}
