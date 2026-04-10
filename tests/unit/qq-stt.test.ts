import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveQqSttConfigFromEnv, transcribeAudioFile } from "../../packages/adapters/qq/src/qq-stt.js";

describe("qq stt", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("resolves volcengine flash config from env", () => {
    const config = resolveQqSttConfigFromEnv({
      QQBOT_STT_PROVIDER: "volcengine-flash",
      QQBOT_STT_APP_ID: "8126477386",
      QQBOT_STT_ACCESS_KEY: "access-key",
      QQBOT_STT_RESOURCE_ID: "volc.bigasr.auc_turbo",
      QQBOT_STT_ENDPOINT: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
      QQBOT_STT_MODEL: "bigmodel"
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      provider: "volcengine-flash",
      endpoint: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
      appId: "8126477386",
      accessKey: "access-key",
      resourceId: "volc.bigasr.auc_turbo",
      model: "bigmodel"
    });
  });

  it("resolves local whisper.cpp config from env", () => {
    const config = resolveQqSttConfigFromEnv({
      QQBOT_STT_PROVIDER: "local-whisper-cpp",
      QQBOT_STT_BINARY_PATH: "/usr/local/bin/whisper-cli",
      QQBOT_STT_MODEL_PATH: "/models/ggml-large-v3.bin",
      QQBOT_STT_LANGUAGE: "zh"
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      provider: "local-whisper-cpp",
      binaryPath: "/usr/local/bin/whisper-cli",
      modelPath: "/models/ggml-large-v3.bin",
      language: "zh"
    });
  });

  it("sends volcengine flash transcription requests with provider-specific headers", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "qq-stt-"));
    tempDirs.push(tempDir);
    const audioPath = path.join(tempDir, "voice.wav");
    writeFileSync(audioPath, "wav-bytes");

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { text: "你是谁？" } }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
    );

    const text = await transcribeAudioFile(
      audioPath,
      {
        provider: "volcengine-flash",
        endpoint: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
        appId: "8126477386",
        accessKey: "access-key",
        resourceId: "volc.bigasr.auc_turbo",
        model: "bigmodel"
      },
      fetchFn
    );

    expect(text).toBe("你是谁？");
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Api-App-Key": "8126477386",
      "X-Api-Access-Key": "access-key",
      "X-Api-Resource-Id": "volc.bigasr.auc_turbo",
      "X-Api-Sequence": "-1"
    });
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(init.body as string)).toMatchObject({
      user: { uid: "8126477386" },
      audio: { data: expect.any(String) },
      request: { model_name: "bigmodel" }
    });
  });

  it("invokes local whisper.cpp via command line and reads the generated transcript", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "qq-stt-"));
    tempDirs.push(tempDir);
    const audioPath = path.join(tempDir, "voice.wav");
    writeFileSync(audioPath, "wav-bytes");

    const commandRunner = vi.fn((file, args, callback) => {
      const outputPrefix = args[args.indexOf("-of") + 1];
      writeFileSync(`${outputPrefix}.txt`, "本地 whisper 转写结果\n");
      callback(null, "", "");
    });

    const text = await transcribeAudioFile(
      audioPath,
      {
        provider: "local-whisper-cpp",
        binaryPath: "/usr/local/bin/whisper-cli",
        modelPath: "/models/ggml-large-v3.bin",
        language: "zh"
      },
      undefined,
      commandRunner as never
    );

    expect(text).toBe("本地 whisper 转写结果");
    expect(commandRunner).toHaveBeenCalledOnce();
    expect(commandRunner.mock.calls[0]?.[0]).toBe("/usr/local/bin/whisper-cli");
    expect(commandRunner.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        "-m",
        "/models/ggml-large-v3.bin",
        "-f",
        audioPath,
        "-otxt",
        "-np",
        "-l",
        "zh"
      ])
    );
  });
});
