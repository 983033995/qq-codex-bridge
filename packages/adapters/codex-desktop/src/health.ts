import fs from "node:fs";
import path from "node:path";

export function ensureArtifactDir(baseDir: string): string {
  const artifactDir = path.join(baseDir, "artifacts", "desktop-driver");
  fs.mkdirSync(artifactDir, { recursive: true });
  return artifactDir;
}
