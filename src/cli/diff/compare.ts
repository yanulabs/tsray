export function byFile(
  a: { file: string; line: number },
  b: { file: string; line: number }
): number {
  return a.file.localeCompare(b.file) || a.line - b.line;
}
