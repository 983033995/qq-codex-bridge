import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadCodexSelectorProfile,
  serializeSelectorProfile
} from "../../packages/adapters/codex-desktop/src/selector-registry.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex selector registry", () => {
  it("uses the v27 built-in profile by default and returns independent copies", () => {
    const first = loadCodexSelectorProfile();
    const second = loadCodexSelectorProfile();

    expect(first.profile).toBe("v27");
    expect(first.composer[0]).toBe('[data-codex-composer="true"]');
    first.composer.push(".mutated");
    expect(second.composer).not.toContain(".mutated");
  });

  it("keeps packaged JSON profiles synchronized with built-in fallbacks", () => {
    for (const profileName of ["v26", "v27"]) {
      const packaged = JSON.parse(fs.readFileSync(
        path.join(process.cwd(), "selectors", `${profileName}.json`),
        "utf8"
      ));
      expect(packaged).toEqual(loadCodexSelectorProfile({ profile: profileName }));
    }
  });

  it("loads and strictly validates an explicit JSON profile", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "selector-profile-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "custom.json");
    const profile = {
      ...loadCodexSelectorProfile({ profile: "v26" }),
      profile: "custom",
      composer: ["#custom-composer"]
    };
    fs.writeFileSync(filePath, JSON.stringify(profile));

    expect(loadCodexSelectorProfile({ filePath })).toEqual(profile);
  });

  it("rejects damaged or incomplete explicit profiles", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "selector-profile-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "broken.json");
    fs.writeFileSync(filePath, JSON.stringify({ profile: "broken", composer: [] }));

    expect(() => loadCodexSelectorProfile({ filePath })).toThrow();
    expect(() => loadCodexSelectorProfile({ profile: "v99" })).toThrow(
      /unsupported Codex selector profile/
    );
  });

  it("serializes selector values without allowing script string escape", () => {
    const profile = {
      ...loadCodexSelectorProfile(),
      composer: ['textarea\"; globalThis.injected = true; //']
    };
    const serialized = serializeSelectorProfile(profile);

    expect(JSON.parse(serialized)).toEqual(profile);
    expect(serialized).toContain('textarea\\\"; globalThis.injected');
  });
});
