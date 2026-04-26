import { ChatgptDesktopDriver } from "../../../packages/adapters/chatgpt-desktop/src/driver.js";
import type { ChatgptDesktopRunInput } from "../../../packages/adapters/chatgpt-desktop/src/types.js";

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function printError(msg: string): void {
  process.stderr.write(msg + "\n");
}

const BOOL_FLAGS = new Set(["json", "help"]);

function parseArgs(argv: string[]): {
  command: string;
  args: string[];
  flags: Record<string, string | boolean>;
} {
  const [, , command = "help", ...rest] = argv;
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      if (BOOL_FLAGS.has(key)) {
        flags[key] = true;
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      args.push(tok);
    }
  }

  return { command, args, flags };
}

async function cmdHealth(
  driver: ChatgptDesktopDriver,
  flags: Record<string, string | boolean>
): Promise<void> {
  const result = await driver.health();
  if (flags["json"]) {
    printJson(result);
  } else {
    console.log(`App running:   ${result.appRunning}`);
    console.log(`Accessibility: ${result.accessibility}`);
    console.log(`Cache dir:     ${result.cacheDirFound}`);
    console.log(`Frontmost:     ${result.frontmost}`);
    console.log(`Overall OK:    ${result.ok}`);
  }
  process.exit(result.ok ? 0 : 1);
}

async function cmdAsk(
  driver: ChatgptDesktopDriver,
  args: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const prompt = args[0];
  if (!prompt) {
    printError("Usage: chatgpt-desktop ask [--json] [--session <key>] <prompt>");
    process.exit(1);
  }

  const input: ChatgptDesktopRunInput = {
    mode: "text",
    prompt,
    sessionKey: typeof flags["session"] === "string" ? flags["session"] : undefined,
    timeoutMs: typeof flags["timeout"] === "string" ? Number(flags["timeout"]) : undefined
  };

  const result = await driver.run(input);
  if (flags["json"]) {
    printJson(result);
  } else if (result.ok) {
    console.log(result.text);
  } else {
    printError(`Error [${result.errorCode}]: ${result.message}`);
  }
  process.exit(result.ok ? 0 : 1);
}

async function cmdImage(
  driver: ChatgptDesktopDriver,
  args: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const prompt = args[0];
  if (!prompt) {
    printError("Usage: chatgpt-desktop image [--json] [--out-dir <dir>] [--session <key>] <prompt>");
    process.exit(1);
  }

  const outDir = typeof flags["out-dir"] === "string" ? flags["out-dir"] : undefined;
  const input: ChatgptDesktopRunInput = {
    mode: "image",
    prompt,
    sessionKey: typeof flags["session"] === "string" ? flags["session"] : undefined,
    timeoutMs: typeof flags["timeout"] === "string" ? Number(flags["timeout"]) : undefined
  };

  const result = await driver.run(input);
  if (flags["json"]) {
    printJson(result);
  } else if (result.ok) {
    for (const m of result.media) {
      console.log(m.localPath);
    }
    if (result.text) console.log(result.text);
  } else {
    printError(`Error [${result.errorCode}]: ${result.message}`);
  }

  void outDir; // outDir is passed via driver opts at construction time; noted for future use
  process.exit(result.ok ? 0 : 1);
}

async function cmdImages(
  driver: ChatgptDesktopDriver,
  args: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const prompt = args[0];
  if (!prompt) {
    printError("Usage: chatgpt-desktop images [--json] [--count <n>] [--out-dir <dir>] <prompt>");
    process.exit(1);
  }

  const count = typeof flags["count"] === "string" ? Math.max(1, parseInt(flags["count"], 10)) : 1;
  const results = [];
  let anyFailed = false;

  for (let i = 0; i < count; i++) {
    const input: ChatgptDesktopRunInput = {
      mode: "image",
      prompt: `${prompt} (第 ${i + 1} 张，共 ${count} 张)`,
      sessionKey: typeof flags["session"] === "string" ? flags["session"] : undefined,
      timeoutMs: typeof flags["timeout"] === "string" ? Number(flags["timeout"]) : undefined
    };
    const result = await driver.run(input);
    results.push(result);
    if (!result.ok) anyFailed = true;
  }

  if (flags["json"]) {
    printJson(results);
  } else {
    for (const r of results) {
      if (r.ok) {
        for (const m of r.media) console.log(m.localPath);
      } else {
        printError(`Error [${r.errorCode}]: ${r.message}`);
      }
    }
  }

  process.exit(anyFailed ? 1 : 0);
}

function printHelp(): void {
  console.log(`chatgpt-desktop <command> [options]

Commands:
  health                    Check App, accessibility and cache dir
  ask <prompt>              Send a text message and print reply
  image <prompt>            Generate an image and print local path
  images --count N <prompt> Generate N images serially

Options:
  --json                    Output JSON
  --session <key>           Session key for conversation continuity
  --out-dir <dir>           Output directory for images
  --timeout <ms>            Override reply timeout in milliseconds
  --count <n>               Number of images (images command only)
`);
}

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv);

  const outDir = typeof flags["out-dir"] === "string" ? flags["out-dir"] : undefined;
  const driver = new ChatgptDesktopDriver({ destDir: outDir });

  switch (command) {
    case "health":
      await cmdHealth(driver, flags);
      break;
    case "ask":
    case "chat":
      await cmdAsk(driver, args, flags);
      break;
    case "image":
      await cmdImage(driver, args, flags);
      break;
    case "images":
      await cmdImages(driver, args, flags);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      printError(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
