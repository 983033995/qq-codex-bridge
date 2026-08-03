import fs from "node:fs";
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const codexSelectorProfileSchema = z.object({
  profile: nonEmptyString,
  composer: z.array(nonEmptyString).min(1),
  assistantUnit: nonEmptyString,
  contentUnit: nonEmptyString,
  contentUnitKeyAttribute: nonEmptyString,
  threadTitle: nonEmptyString,
  threadTime: nonEmptyString,
  controls: nonEmptyString,
  streamingControls: nonEmptyString,
  assistantStatus: nonEmptyString,
  markdownContent: nonEmptyString,
  mediaElements: nonEmptyString,
  submitButtonPrimaryClass: nonEmptyString,
  streamingStopIconPaths: z.array(nonEmptyString).min(1)
}).strict();

export type CodexSelectorProfile = z.infer<typeof codexSelectorProfileSchema>;

const V26_PROFILE: CodexSelectorProfile = {
  profile: "v26",
  composer: [
    "textarea",
    "input[type=\"text\"]",
    "[contenteditable=\"true\"]",
    "[role=\"textbox\"]"
  ],
  assistantUnit: "[data-content-search-unit-key$=\":assistant\"]",
  contentUnit: "[data-content-search-unit-key]",
  contentUnitKeyAttribute: "data-content-search-unit-key",
  threadTitle: "[data-thread-title=\"true\"]",
  threadTime: ".text-token-description-foreground",
  controls: "button, [role=\"button\"]",
  streamingControls: "button, [role=\"button\"], [aria-busy=\"true\"]",
  assistantStatus: ".text-xs, [aria-live], [data-state], [class*=\"status\"], [class*=\"loading\"]",
  markdownContent: "[class*=\"_markdownContent_\"]",
  mediaElements: "img[src], audio[src], audio source[src], video[src], video source[src], a[href]",
  submitButtonPrimaryClass: "size-token-button-composer",
  streamingStopIconPaths: ["M4.5 5.75C4.5 5.05964", "M4.5 5.75C4.5 5.0596"]
};

const V27_PROFILE: CodexSelectorProfile = {
  ...V26_PROFILE,
  profile: "v27",
  composer: ["[data-codex-composer=\"true\"]", ...V26_PROFILE.composer]
};

const BUILTIN_PROFILES = new Map<string, CodexSelectorProfile>([
  [V26_PROFILE.profile, V26_PROFILE],
  [V27_PROFILE.profile, V27_PROFILE]
]);

export const DEFAULT_SELECTOR_PROFILE = "v27";

export function loadCodexSelectorProfile(options: {
  profile?: string;
  filePath?: string | null;
} = {}): CodexSelectorProfile {
  if (options.filePath) {
    const raw = JSON.parse(fs.readFileSync(options.filePath, "utf8")) as unknown;
    return cloneProfile(codexSelectorProfileSchema.parse(raw));
  }

  const profileName = options.profile?.trim() || DEFAULT_SELECTOR_PROFILE;
  const profile = BUILTIN_PROFILES.get(profileName);
  if (!profile) {
    throw new Error(`unsupported Codex selector profile: ${profileName}`);
  }
  return cloneProfile(profile);
}

export function serializeSelectorProfile(profile: CodexSelectorProfile): string {
  return JSON.stringify(codexSelectorProfileSchema.parse(profile));
}

function cloneProfile(profile: CodexSelectorProfile): CodexSelectorProfile {
  return {
    ...profile,
    composer: [...profile.composer],
    streamingStopIconPaths: [...profile.streamingStopIconPaths]
  };
}
