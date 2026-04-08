export function parseAssistantReply(snapshotText: string): string {
  const lines = snapshotText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const assistantLines = lines
    .filter((line) => line.startsWith("Assistant:"))
    .map((line) => line.replace(/^Assistant:\s*/, ""));

  return assistantLines.at(-1) ?? "";
}
