import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execa, type Subprocess } from "execa";

import { getHarnessCode } from "../harness/harness.js";
import {
	activeAppSession,
	appendLog,
	recentDaemonLogs,
	setActiveAppSession,
	setAppConnectedResolver,
} from "../session.js";
import { APP_LAUNCH_TIMEOUT_MS, type FlutterDaemonEvent } from "../types.js";

// Tracks the most recent daemon output timestamp.
// Used by waitForAppConnection to implement an activity-aware timeout:
// the app only times out if the daemon goes silent (build stalled),
// not simply because a slow Gradle build exceeded a fixed deadline.
let lastDaemonActivityMs = Date.now();

/** How long we tolerate silence from the daemon before giving up. */
const IDLE_TIMEOUT_MS = 60_000;

// ─── Pubspec Helpers ────────────────────────────────────────────────────────

export async function readPackageName(
	projectPath: string,
): Promise<string | undefined> {
	try {
		const content = await fs.readFile(
			path.join(projectPath, "pubspec.yaml"),
			"utf-8",
		);
		const match = content.match(/^name:\s+(\S+)/m);
		return match?.[1];
	} catch {
		return undefined;
	}
}

// ─── Port Allocation ────────────────────────────────────────────────────────

/** Get a free port by briefly binding to port 0, capturing the OS-assigned port. */
export function getFreePort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, () => {
			const addr = srv.address();
			if (typeof addr === "object" && addr !== null) {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error("Could not determine free port")));
			}
		});
		srv.on("error", reject);
	});
}

// ─── Flutter Daemon Helpers ─────────────────────────────────────────────────

export function parseDaemonEvents(raw: string): FlutterDaemonEvent[] {
	const parsedEvents: FlutterDaemonEvent[] = [];
	for (const line of raw.split("\\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) continue;

		try {
			const data = JSON.parse(trimmed);
			const events = Array.isArray(data) ? data : [data];
			parsedEvents.push(...events);
		} catch {
			// Non-JSON lines are expected (build output, etc.)
		}
	}
	return parsedEvents;
}

export function processDaemonOutput(raw: string): void {
	const events = parseDaemonEvents(raw);
	for (const event of events) {
		if (event.event === "app.debugPort" && event.params?.wsUri) {
			if (activeAppSession)
				activeAppSession.observatoryUri = event.params.wsUri as string;
			console.error(`Captured Observatory URI: ${event.params.wsUri}`);
		}
		if (event.event === "app.started" && event.params?.appId) {
			if (activeAppSession)
				activeAppSession.appId = event.params.appId as string;
			console.error(`Captured App ID: ${event.params.appId}`);
		}
	}
}

// ─── Lifecycle Helpers ──────────────────────────────────────────────────────

export async function injectHarnessFile(
	projectPath: string,
): Promise<string | undefined> {
	const testDir = path.join(projectPath, "integration_test");
	await fs.mkdir(testDir, { recursive: true });

	const packageName = await readPackageName(projectPath);
	await fs.writeFile(
		path.join(testDir, "mcp_harness.dart"),
		getHarnessCode(packageName),
	);
	return packageName;
}

export function spawnFlutterDaemon(
	projectPath: string,
	port: number,
	deviceId: string | null,
): Subprocess {
	const flutterArgs = [
		"run",
		"--machine",
		"--target",
		"integration_test/mcp_harness.dart",
		"--dart-define",
		`WS_PORT=${port}`,
		...(deviceId ? ["-d", deviceId] : []),
	];

	console.error(`Spawning: flutter ${flutterArgs.join(" ")}`);

	if (activeAppSession) activeAppSession.process.kill();

	const flutterDaemonProcess = execa("flutter", flutterArgs, {
		cwd: projectPath,
		stdio: ["pipe", "pipe", "pipe"],
	});
	flutterDaemonProcess.catch(() => {}); // Prevent unhandled rejection on kill
	return flutterDaemonProcess;
}

export function attachDaemonStreams(flutterProcess: Subprocess): void {
	flutterProcess.stdout?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		console.error(`[Flutter]: ${text}`);
		appendLog(text);
		processDaemonOutput(text);
		lastDaemonActivityMs = Date.now();
	});

	flutterProcess.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		console.error(`[Flutter Err]: ${text}`);
		appendLog(text);
		lastDaemonActivityMs = Date.now();
	});

	flutterProcess.on("exit", (code: number | null) => {
		console.error(`Flutter process exited with code ${code}`);
		setActiveAppSession(null);
	});
}

export async function waitForAppConnection(
	flutterProcess: Subprocess,
): Promise<void> {
	console.error("Waiting for app to connect...");
	lastDaemonActivityMs = Date.now();

	return new Promise<void>((resolve, reject) => {
		setAppConnectedResolver(resolve);
		let settled = false;

		// Hard ceiling: even with continuous activity, give up after this.
		const hardTimeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(
				new Error(
					`Timeout waiting for app to start (exceeded ${APP_LAUNCH_TIMEOUT_MS / 1000}s hard limit). ` +
						"The build may be stuck. Check the Flutter/Gradle output above for errors.",
				),
			);
		}, APP_LAUNCH_TIMEOUT_MS);

		// Soft (activity-aware) timeout: polls every 5s and rejects only
		// if the daemon has been completely silent for IDLE_TIMEOUT_MS.
		// This lets slow-but-progressing Android Gradle builds continue
		// without hitting the hard ceiling.
		const activityPoll = setInterval(() => {
			if (settled) {
				clearInterval(activityPoll);
				return;
			}
			const silenceMs = Date.now() - lastDaemonActivityMs;
			if (silenceMs >= IDLE_TIMEOUT_MS) {
				settled = true;
				clearTimeout(hardTimeout);
				clearInterval(activityPoll);
				reject(
					new Error(
						`Timeout waiting for app to start — no output from Flutter for ${Math.round(silenceMs / 1000)}s. ` +
							"The build appears stalled. Check device connectivity and Gradle/Xcode logs.",
					),
				);
			}
		}, 5_000);

		flutterProcess.on("exit", (code: number | null) => {
			if (settled) return;
			if (code !== null && code !== 0) {
				settled = true;
				clearTimeout(hardTimeout);
				clearInterval(activityPoll);
				const recentOutput = recentDaemonLogs.slice(-20).join("\n");
				reject(new Error(`Build failed (exit code ${code}):\n${recentOutput}`));
			}
		});

		// Clean up the interval when resolved (app connected successfully)
		const originalResolve = resolve;
		setAppConnectedResolver(() => {
			if (settled) return;
			settled = true;
			clearTimeout(hardTimeout);
			clearInterval(activityPoll);
			originalResolve();
		});
	});
}
