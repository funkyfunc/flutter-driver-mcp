import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, WebSocket } from "ws";
import { execa } from "execa";
import fs from "fs/promises";
import path from "path";
import os from "os";

import { getHarnessCode } from "./harness.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import {
  type AppSession,
  type FinderPayload,
  type FlutterDaemonEvent,
  type FlutterDevice,
  type JsonRpcResponse,
  type ScreenshotResult,
  type ToolArgs,
  type ToolHandler,
  type ToolResponse,
  APP_LAUNCH_TIMEOUT_MS,
  GRACEFUL_STOP_TIMEOUT_MS,
  MAX_LOG_LINES,
  RPC_TIMEOUT_MS,
  SCREENSHOT_DIR,
  textResponse,
  jsonResponse,
  toErrorMessage,
  toExecErrorMessage,
} from "./types.js";

// ─── Server State ───────────────────────────────────────────────────────────

let session: AppSession | null = null;
let wsServer: WebSocketServer | null = null;
let wsPort: number | null = null;
let appStartedResolver: (() => void) | null = null;

const logBuffer: string[] = [];
const pendingRequests = new Map<string, { resolve: (val: unknown) => void; reject: (err: Error) => void }>();
let nextMsgId = 1;

// ─── Log Buffer ─────────────────────────────────────────────────────────────

function appendLog(message: string): void {
  if (logBuffer.length >= MAX_LOG_LINES) logBuffer.shift();
  logBuffer.push(message);
}

// ─── JSON-RPC Transport ─────────────────────────────────────────────────────

async function sendRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!session?.ws) throw new Error("App not connected. Use start_app first.");

  const id = `req_${nextMsgId++}`;
  return new Promise<unknown>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    session!.ws!.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for device response to '${method}'`));
      }
    }, RPC_TIMEOUT_MS);
  });
}

function requireSession(): AppSession {
  if (!session) throw new Error("App is not running. Use start_app first.");
  return session;
}

// ─── WebSocket Server ───────────────────────────────────────────────────────

async function ensureWsServer(): Promise<number> {
  if (wsServer) return wsPort!;

  return new Promise<number>((resolve) => {
    wsServer = new WebSocketServer({ port: 0 });

    wsServer.on("listening", () => {
      const addr = wsServer?.address();
      if (typeof addr === "object" && addr !== null) {
        wsPort = addr.port;
        resolve(wsPort);
      }
    });

    wsServer.on("connection", (ws: WebSocket) => {
      console.error("Device connected via WebSocket");
      if (session) session.ws = ws;

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as JsonRpcResponse;

          if (msg.id && pendingRequests.has(String(msg.id))) {
            const pending = pendingRequests.get(String(msg.id))!;
            pendingRequests.delete(String(msg.id));
            if (msg.error) {
              pending.reject(new Error(msg.error.message || "Unknown error from device"));
            } else {
              pending.resolve(msg.result);
            }
          }

          if (msg.method === "app.started" && appStartedResolver) {
            appStartedResolver();
            appStartedResolver = null;
          }
        } catch {
          console.error("Error parsing WebSocket message");
        }
      });

      ws.on("close", () => {
        console.error("Device disconnected");
        if (session) session.ws = null;
      });
    });
  });
}

// ─── Selector Parsing ───────────────────────────────────────────────────────

function parseTarget(target: string): FinderPayload {
  if (target.startsWith("#")) {
    return { finderType: "byKey", key: target.substring(1) };
  }

  const eqIndex = target.indexOf("=");
  if (eqIndex > 0) {
    const prefix = target.substring(0, eqIndex).trim();
    const value = target.substring(eqIndex + 1).trim().replace(/^['"]|['"]$/g, "");

    switch (prefix) {
      case "text":    return { finderType: "byText", text: value };
      case "type":    return { finderType: "byType", type: value };
      case "tooltip": return { finderType: "byTooltip", tooltip: value };
      case "id":      return { finderType: "byId", id: value };
    }
  }

  throw new Error(
    `Invalid target string: '${target}'. ` +
    `Use '#key', 'text="text"', 'type="type"', or 'tooltip="tooltip"'.`
  );
}

/** Resolve target in args if present, returning a clean payload for the harness. */
function resolveTargetArgs(args: ToolArgs): Record<string, unknown> {
  const payload = { ...args };
  if (typeof payload.target === "string") {
    const finder = parseTarget(payload.target);
    delete payload.target;
    Object.assign(payload, finder);
  }
  return payload;
}

// ─── Pubspec Helpers ────────────────────────────────────────────────────────

async function readPackageName(projectPath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(path.join(projectPath, "pubspec.yaml"), "utf-8");
    const match = content.match(/^name:\s+(\S+)/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

// ─── Flutter Daemon Helpers ─────────────────────────────────────────────────

function writeDaemonCommand(method: string, params: Record<string, unknown>): void {
  const s = requireSession();
  const cmd = JSON.stringify([{ method, params, id: nextMsgId++ }]) + "\n";
  s.process.stdin!.write(cmd);
}

function parseDaemonEvents(raw: string): void {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) continue;

    try {
      let events = JSON.parse(trimmed) as FlutterDaemonEvent | FlutterDaemonEvent[];
      if (!Array.isArray(events)) events = [events];

      for (const event of events) {
        if (event.event === "app.debugPort" && event.params?.wsUri) {
          if (session) session.observatoryUri = event.params.wsUri as string;
          console.error(`Captured Observatory URI: ${event.params.wsUri}`);
        }
        if (event.event === "app.started" && event.params?.appId) {
          if (session) session.appId = event.params.appId as string;
          console.error(`Captured App ID: ${event.params.appId}`);
        }
      }
    } catch {
      // Non-JSON lines are expected (build output, etc.)
    }
  }
}

// ─── Tool Handlers ──────────────────────────────────────────────────────────

// -- Lifecycle --

async function handleStartApp(args: ToolArgs): Promise<ToolResponse> {
  const projectPath = args.project_path as string;
  const deviceId = (args.device_id as string) || null;

  // Reset
  logBuffer.length = 0;

  // 1. Start WebSocket server
  const port = await ensureWsServer();

  // 2. Inject harness
  const testDir = path.join(projectPath, "integration_test");
  await fs.mkdir(testDir, { recursive: true });

  const packageName = await readPackageName(projectPath);
  await fs.writeFile(path.join(testDir, "mcp_harness.dart"), getHarnessCode(packageName));

  // 3. Spawn Flutter
  const flutterArgs = [
    "run", "--machine",
    "--target", "integration_test/mcp_harness.dart",
    "--dart-define", `WS_URL=ws://localhost:${port}`,
    ...(deviceId ? ["-d", deviceId] : []),
  ];

  console.error(`Spawning: flutter ${flutterArgs.join(" ")}`);

  if (session) session.process.kill();

  const proc = execa("flutter", flutterArgs, {
    cwd: projectPath,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.catch(() => {}); // Prevent unhandled rejection on kill

  session = {
    process: proc,
    ws: null,
    appId: null,
    observatoryUri: null,
    projectPath,
    deviceId,
  };

  // Stream and parse stdout
  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    console.error(`[Flutter]: ${text}`);
    appendLog(text);
    parseDaemonEvents(text);
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    console.error(`[Flutter Err]: ${text}`);
    appendLog(text);
  });

  proc.on("exit", (code: number | null) => {
    console.error(`Flutter process exited with code ${code}`);
    session = null;
  });

  // 4. Wait for harness connection
  console.error("Waiting for app to connect...");
  await new Promise<void>((resolve, reject) => {
    appStartedResolver = resolve;
    setTimeout(() => reject(new Error("Timeout waiting for app to start")), APP_LAUNCH_TIMEOUT_MS);
  });

  return textResponse(`App started and connected! (Injected harness with package: ${packageName ?? "unknown"})`);
}

async function handleStopApp(): Promise<ToolResponse> {
  // 1. Gracefully stop via flutter daemon protocol
  if (session?.appId) {
    try {
      writeDaemonCommand("app.stop", { appId: session.appId });
      console.error("Sent app.stop command to Flutter daemon.");

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), GRACEFUL_STOP_TIMEOUT_MS);
        session?.process.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } catch {
      console.error("Error sending app.stop");
    }
  }

  // 2. Force kill if still alive
  if (session) {
    try { session.process.kill("SIGKILL"); } catch { /* already dead */ }
  }

  // 3. Close WebSocket
  session?.ws?.close();

  // 4. Kill orphaned processes
  if (session?.projectPath) {
    const name = path.basename(session.projectPath);
    await execa("pkill", ["-f", `${name}.*flutter`], { reject: false });
    await execa("pkill", ["-f", `${name}.app`], { reject: false });
  }

  session = null;

  // 5. Clean up temp screenshots
  const tempDir = path.join(os.tmpdir(), SCREENSHOT_DIR);
  try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

  return textResponse("App stopped.");
}

async function handlePilotHotRestart(): Promise<ToolResponse> {
  const s = requireSession();
  if (!s.appId) throw new Error("App ID not available. Cannot restart.");

  writeDaemonCommand("app.restart", { appId: s.appId, fullRestart: true });
  console.error("Sent hot restart command.");
  return textResponse("Hot restart command sent.");
}

async function handleListDevices(): Promise<ToolResponse> {
  const { stdout } = await execa("flutter", ["devices", "--machine"]);
  const devices = JSON.parse(stdout) as FlutterDevice[];

  if (devices.length === 0) {
    return textResponse(
      "No devices found. Make sure a simulator/emulator is running or a physical device is connected."
    );
  }

  const summary = devices
    .map((d) => `• ${d.name} (${d.id}) — ${d.targetPlatform}, ${d.isSupported ? "✅ supported" : "❌ unsupported"}`)
    .join("\n");

  return textResponse(
    `Found ${devices.length} device(s):\n${summary}\n\n` +
    "Use the device ID (e.g. 'macos', 'chrome', or a simulator UUID) with start_app."
  );
}

// -- Inspection --

async function handleTakeScreenshot(args: ToolArgs): Promise<ToolResponse> {
  const s = requireSession();
  const savePath = args.save_path as string | undefined;
  const screenshotType = (args.type as string) || "app";

  // App-mode: render from Flutter frame directly (most reliable)
  if (screenshotType === "app") {
    const result = (await sendRpc("screenshot", {})) as ScreenshotResult;
    if (result.error) throw new Error(result.error);

    if (savePath) {
      await fs.writeFile(savePath, Buffer.from(result.data, "base64"));
      return textResponse(`Screenshot saved to ${savePath}`);
    }
    return {
      content: [
        { type: "text", text: "Screenshot captured:" },
        { type: "image", data: result.data, mimeType: "image/png" },
      ],
    };
  }

  // Device/Skia mode: use flutter CLI screenshot
  if (!s.observatoryUri) {
    throw new Error("Observatory URI not available. Screenshot requires a debug/profile build with VM service enabled.");
  }

  const tempDir = path.join(os.tmpdir(), SCREENSHOT_DIR);
  await fs.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `screenshot_${Date.now()}.png`);

  const screenshotArgs = ["screenshot", `--type=${screenshotType}`, "-o", tempPath];
  if (screenshotType !== "device") screenshotArgs.push(`--vm-service-url=${s.observatoryUri}`);
  if (s.deviceId) screenshotArgs.push("-d", s.deviceId);

  console.error(`Taking screenshot via: flutter ${screenshotArgs.join(" ")}`);

  try {
    await execa("flutter", screenshotArgs, { cwd: s.projectPath });
  } catch (flutterErr) {
    if (s.deviceId === "macos" && screenshotType === "device") {
      console.error("Flutter screenshot failed, falling back to macOS screencapture...");
      await execa("screencapture", ["-x", tempPath]);
    } else {
      throw flutterErr;
    }
  }

  await fs.access(tempPath);

  if (savePath) {
    await fs.copyFile(tempPath, savePath);
    return textResponse(`Screenshot saved to ${savePath}`);
  }

  const buffer = await fs.readFile(tempPath);
  await fs.unlink(tempPath);
  return {
    content: [
      { type: "text", text: "Screenshot captured:" },
      { type: "image", data: buffer.toString("base64"), mimeType: "image/png" },
    ],
  };
}

// -- Environment --

async function handleSimulateBackground(args: ToolArgs): Promise<ToolResponse> {
  const durationMs = (args.duration_ms as number) ?? 2000;
  const deviceId = session?.deviceId;

  if (deviceId?.includes("-")) {
    try {
      await execa("xcrun", ["simctl", "launch", deviceId, "com.apple.springboard"]);
      await new Promise((r) => setTimeout(r, durationMs));
    } catch { /* ignore */ }
    return textResponse(
      "Simulated backgrounding via simctl (Note: resuming might require manual tap if bundle ID is unknown)"
    );
  }

  if (deviceId?.startsWith("emulator-")) {
    try {
      await execa("adb", ["-s", deviceId, "shell", "input", "keyevent", "KEYCODE_HOME"]);
      await new Promise((r) => setTimeout(r, durationMs));
    } catch { /* ignore */ }
    return textResponse("Simulated backgrounding via adb");
  }

  return textResponse("Device not supported for simulate_background");
}

async function handleSetNetworkStatus(args: ToolArgs): Promise<ToolResponse> {
  const wifi = args.wifi as boolean;
  const deviceId = session?.deviceId;

  if (deviceId?.includes("-")) {
    return textResponse(
      "Network toggling in iOS simulators is complex and usually requires external proxies. " +
      "Consider using 'intercept_network' instead."
    );
  }

  if (deviceId?.startsWith("emulator-")) {
    await execa("adb", ["-s", deviceId, "shell", "svc", "wifi", wifi ? "enable" : "disable"]);
    return textResponse(`Set WiFi to ${wifi} via adb`);
  }

  return textResponse("Device not supported for set_network_status");
}

// -- Utilities --

async function handleReadLogs(args: ToolArgs): Promise<ToolResponse> {
  const count = (args.lines as number) ?? 50;
  return textResponse(logBuffer.slice(-count).join(""));
}

async function handleValidateProject(args: ToolArgs): Promise<ToolResponse> {
  const projectPath = args.project_path as string;
  const autoFix = args.auto_fix as boolean | undefined;
  const report: string[] = [];
  let success = true;

  // 1. Check pubspec.yaml
  const pubspecPath = path.join(projectPath, "pubspec.yaml");
  try {
    const pubspec = await fs.readFile(pubspecPath, "utf-8");

    for (const [dep, fixArgs] of [
      ["integration_test", ["pub", "add", "integration_test", "--sdk=flutter"]],
      ["web_socket_channel", ["pub", "add", "web_socket_channel"]],
    ] as const) {
      const found = pubspec.includes(`${dep}:`);
      if (!found) {
        report.push(`❌ Missing '${dep}' in pubspec.yaml.`);
        success = false;
        if (autoFix) {
          await execa("flutter", [...fixArgs], { cwd: projectPath });
          report.push(`✅ Added '${dep}'.`);
        }
      } else {
        report.push(`✅ '${dep}' found.`);
      }
    }
  } catch (e) {
    report.push(`❌ Could not read pubspec.yaml: ${toErrorMessage(e)}`);
    success = false;
  }

  // 2. Check macOS entitlements
  const entitlementsPath = path.join(projectPath, "macos/Runner/DebugProfile.entitlements");
  try {
    await fs.access(entitlementsPath);
    const content = await fs.readFile(entitlementsPath, "utf-8");

    if (!content.includes("com.apple.security.network.client")) {
      report.push("❌ Missing 'com.apple.security.network.client' in DebugProfile.entitlements.");
      success = false;
      if (autoFix) {
        const idx = content.lastIndexOf("</dict>");
        if (idx !== -1) {
          const patched = content.slice(0, idx) +
            "\t<key>com.apple.security.network.client</key>\n\t<true/>\n" +
            content.slice(idx);
          await fs.writeFile(entitlementsPath, patched);
          report.push("✅ Added network client entitlement to DebugProfile.entitlements.");
        } else {
          report.push("⚠️ Could not auto-fix entitlements (structure mismatch).");
        }
      }
    } else {
      report.push("✅ macOS network client entitlement found.");
    }
  } catch {
    // macOS folder doesn't exist — skip
  }

  // 3. Check Android permissions
  const androidMain = path.join(projectPath, "android/app/src/main/AndroidManifest.xml");
  const androidDebug = path.join(projectPath, "android/app/src/debug/AndroidManifest.xml");
  try {
    await fs.access(androidMain);
    const mainManifest = await fs.readFile(androidMain, "utf-8");
    let hasInternet = mainManifest.includes("android.permission.INTERNET");

    if (!hasInternet) {
      try {
        const debugManifest = await fs.readFile(androidDebug, "utf-8");
        hasInternet = debugManifest.includes("android.permission.INTERNET");
      } catch { /* debug manifest may not exist */ }
    }

    if (!hasInternet) {
      report.push("❌ Missing 'android.permission.INTERNET' in AndroidManifest.xml (main or debug).");
      success = false;
      if (autoFix) {
        try {
          let debugContent: string;
          try {
            debugContent = await fs.readFile(androidDebug, "utf-8");
          } catch {
            debugContent = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app">\n</manifest>';
            await fs.mkdir(path.dirname(androidDebug), { recursive: true });
          }

          if (debugContent.includes("</manifest>")) {
            const patched = debugContent.replace(
              "</manifest>",
              '    <uses-permission android:name="android.permission.INTERNET"/>\n</manifest>',
            );
            await fs.writeFile(androidDebug, patched);
            report.push("✅ Added INTERNET permission to debug AndroidManifest.xml.");
          } else {
            report.push("⚠️ Could not auto-fix AndroidManifest.xml (structure mismatch).");
          }
        } catch (e) {
          report.push(`⚠️ Failed to auto-fix Android permissions: ${toErrorMessage(e)}`);
        }
      }
    } else {
      report.push("✅ Android INTERNET permission found.");
    }
  } catch {
    // Android folder doesn't exist — skip
  }

  // 4. Check web
  try {
    await fs.access(path.join(projectPath, "web/index.html"));
    report.push("✅ Web index.html found.");
  } catch {
    // Not a web project — skip
  }

  // 5. Ensure harness is in .gitignore
  const gitignorePath = path.join(projectPath, ".gitignore");
  try {
    await fs.access(gitignorePath);
    const gitignore = await fs.readFile(gitignorePath, "utf-8");
    if (!gitignore.includes("integration_test/mcp_harness.dart")) {
      if (autoFix) {
        await fs.appendFile(gitignorePath, "\n# Flutter Pilot MCP Harness\nintegration_test/mcp_harness.dart\n");
        report.push("✅ Added 'integration_test/mcp_harness.dart' to .gitignore.");
      } else {
        report.push("❌ Missing 'integration_test/mcp_harness.dart' in .gitignore.");
        success = false;
      }
    }
  } catch {
    // No .gitignore — skip
  }

  return {
    content: [{ type: "text", text: report.join("\\n") }],
    isError: !success && !autoFix,
  };
}

// ─── Reusable Handler Patterns ──────────────────────────────────────────────

/** Forward a command directly to the Dart harness, returning JSON. */
function forwardToHarness(method: string, pretty = false): ToolHandler {
  return async (args) => {
    const payload = resolveTargetArgs(args);
    const result = await sendRpc(method, payload);
    return jsonResponse(result, pretty);
  };
}

/** Forward with special handling for scroll_until_visible's nested scrollable target. */
async function handleScrollUntilVisible(args: ToolArgs): Promise<ToolResponse> {
  const payload = resolveTargetArgs(args);
  if (typeof payload.scrollable_target === "string") {
    payload.scrollable = parseTarget(payload.scrollable_target);
    delete payload.scrollable_target;
  }
  const result = await sendRpc("scroll_until_visible", payload);
  return jsonResponse(result);
}

// ─── Dispatch Map ───────────────────────────────────────────────────────────

const handlers: Record<string, ToolHandler> = {
  // Lifecycle
  start_app:           handleStartApp,
  stop_app:            handleStopApp,
  pilot_hot_restart:   handlePilotHotRestart,
  list_devices:        handleListDevices,

  // Interaction
  tap:                 forwardToHarness("tap"),
  enter_text:          forwardToHarness("enter_text"),
  scroll:              forwardToHarness("scroll"),
  scroll_until_visible: handleScrollUntilVisible,
  wait_for:            forwardToHarness("wait_for"),

  // Inspection
  get_widget_tree:     forwardToHarness("get_widget_tree", true),
  get_accessibility_tree: forwardToHarness("get_accessibility_tree", true),
  explore_screen:      forwardToHarness("explore_screen", true),
  take_screenshot:     handleTakeScreenshot,

  // Assertions
  assert_exists:       forwardToHarness("assert_exists"),
  assert_not_exists:   forwardToHarness("assert_not_exists"),
  assert_text_equals:  forwardToHarness("assert_text_equals"),
  assert_state:        forwardToHarness("assert_state"),

  // Navigation & Environment
  navigate_to:         forwardToHarness("navigate_to"),
  intercept_network:   forwardToHarness("intercept_network"),
  simulate_background: handleSimulateBackground,
  set_network_status:  handleSetNetworkStatus,

  // Utilities
  read_logs:           handleReadLogs,
  validate_project:    handleValidateProject,
};

// ─── MCP Server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "flutter-test-pilot", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const toolArgs = (args ?? {}) as ToolArgs;

  try {
    const handler = handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return await handler(toolArgs);
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${toErrorMessage(error)}` }],
      isError: true,
    };
  }
});

// ─── Bootstrap ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();

async function main(): Promise<void> {
  await server.connect(transport);
}

main().catch(console.error);