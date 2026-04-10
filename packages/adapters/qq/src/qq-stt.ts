import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

type FetchLike = typeof fetch;
type ExecFileLike = typeof execFile;
const execFileAsync = promisify(execFile);

export type OpenAiCompatibleSttConfig = {
  provider: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type VolcengineFlashSttConfig = {
  provider: "volcengine-flash";
  endpoint: string;
  appId: string;
  accessKey: string;
  resourceId: string;
  model: string;
};

export type LocalWhisperCppSttConfig = {
  provider: "local-whisper-cpp";
  binaryPath: string;
  modelPath: string;
  language?: string;
};

export type QqSttConfig =
  | OpenAiCompatibleSttConfig
  | VolcengineFlashSttConfig
  | LocalWhisperCppSttConfig;

export function resolveQqSttConfigFromEnv(env: NodeJS.ProcessEnv): QqSttConfig | null {
  if (env.QQBOT_STT_ENABLED === "false") {
    return null;
  }

  if (env.QQBOT_STT_PROVIDER === "local-whisper-cpp") {
    const binaryPath = env.QQBOT_STT_BINARY_PATH;
    const modelPath = env.QQBOT_STT_MODEL_PATH;
    if (!binaryPath || !modelPath) {
      return null;
    }

    return {
      provider: "local-whisper-cpp",
      binaryPath,
      modelPath,
      language: env.QQBOT_STT_LANGUAGE ?? "zh"
    };
  }

  if (env.QQBOT_STT_PROVIDER === "volcengine-flash") {
    const appId = env.QQBOT_STT_APP_ID;
    const accessKey = env.QQBOT_STT_ACCESS_KEY;
    const resourceId = env.QQBOT_STT_RESOURCE_ID;
    const endpoint =
      env.QQBOT_STT_ENDPOINT ??
      "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";

    if (!appId || !accessKey || !resourceId) {
      return null;
    }

    return {
      provider: "volcengine-flash",
      endpoint: endpoint.replace(/\/+$/, ""),
      appId,
      accessKey,
      resourceId,
      model: env.QQBOT_STT_MODEL ?? "bigmodel"
    };
  }

  const apiKey = env.QQBOT_STT_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const baseUrl = env.QQBOT_STT_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = env.QQBOT_STT_MODEL ?? "whisper-1";
  return {
    provider: "openai-compatible",
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model
  };
}

export async function transcribeAudioFile(
  audioPath: string,
  config: QqSttConfig,
  fetchFn: FetchLike = fetch,
  commandRunner: ExecFileLike = execFile
): Promise<string | null> {
  if (config.provider === "local-whisper-cpp") {
    return transcribeWithLocalWhisperCpp(audioPath, config, commandRunner);
  }

  if (config.provider === "volcengine-flash") {
    return transcribeWithVolcengineFlash(audioPath, config, fetchFn);
  }

  const fileBuffer = readFileSync(audioPath);
  const fileName = path.basename(audioPath);
  const mimeType = inferAudioMimeType(fileName);

  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mimeType }), fileName);
  form.append("model", config.model);

  const response = await fetchFn(`${config.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    },
    body: form
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`QQ STT failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }

  const payload = (await response.json()) as { text?: string | null };
  const text = payload.text?.trim();
  return text || null;
}

async function transcribeWithLocalWhisperCpp(
  audioPath: string,
  config: LocalWhisperCppSttConfig,
  commandRunner: ExecFileLike
): Promise<string | null> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "qqbot-whisper-"));
  const outputPrefix = path.join(tempDir, "transcript");
  const args = [
    "-m",
    config.modelPath,
    "-f",
    audioPath,
    "-otxt",
    "-of",
    outputPrefix,
    "-np"
  ];

  if (config.language?.trim()) {
    args.push("-l", config.language.trim());
  }

  try {
    await promisifyCommandRunner(commandRunner)(config.binaryPath, args);
    const transcriptPath = `${outputPrefix}.txt`;
    const transcript = (await readFile(transcriptPath, "utf8")).trim();
    return transcript || null;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function transcribeWithVolcengineFlash(
  audioPath: string,
  config: VolcengineFlashSttConfig,
  fetchFn: FetchLike
): Promise<string | null> {
  const audioBuffer = readFileSync(audioPath);
  const requestId = randomUUID();
  const base64Audio = audioBuffer.toString("base64");
  const response = await fetchFn(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-App-Key": config.appId,
      "X-Api-Access-Key": config.accessKey,
      "X-Api-Resource-Id": config.resourceId,
      "X-Api-Request-Id": requestId,
      "X-Api-Sequence": "-1"
    },
    body: JSON.stringify({
      user: {
        uid: config.appId
      },
      audio: {
        data: base64Audio
      },
      request: {
        model_name: config.model
      }
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`QQ STT failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }

  const payload = (await response.json()) as
    | { result?: { text?: string | null } }
    | { text?: string | null };
  const text = extractVolcengineTranscript(payload)?.trim();
  return text || null;
}

function extractVolcengineTranscript(
  payload: { result?: { text?: string | null } } | { text?: string | null }
): string | null | undefined {
  if ("text" in payload) {
    return payload.text;
  }

  if ("result" in payload) {
    return payload.result?.text;
  }

  return null;
}

function promisifyCommandRunner(commandRunner: ExecFileLike) {
  if (commandRunner === execFile) {
    return execFileAsync;
  }

  return (file: string, args: string[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      commandRunner(file, args, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
          stderr: typeof stderr === "string" ? stderr : String(stderr ?? "")
        });
      });
    });
}

function inferAudioMimeType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  switch (extension) {
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
      return "audio/ogg";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".amr":
      return "audio/amr";
    default:
      return "application/octet-stream";
  }
}
