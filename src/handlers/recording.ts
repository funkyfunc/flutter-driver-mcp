import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa, type Subprocess } from "execa";
import { readPackageName } from "../infra/flutter-daemon.js";
import {
	activeRecording,
	requireSession,
	setActiveRecording,
} from "../session.js";
import {
	type ActiveRecording,
	MAX_RECORDING_DURATION_MS,
	RECORDING_DIR,
	type RecordingProcess,
} from "../types.js";
import { textResponse, toExecErrorMessage } from "../utils.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const GRACEFUL_STOP_WAIT_MS = 5_000;
const ANDROID_DEVICE_RECORDING_PATH = "/sdcard/mcp_recording.mp4";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Detects the target platform from the device ID string. */
function detectPlatform(deviceId: string): "ios" | "macos" | "android" | null {
	if (deviceId === "macos") return "macos";

	// iOS Simulator UUIDs follow the 8-4-4-4-12 hex pattern
	if (/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(deviceId)) {
		return "ios";
	}

	// Android emulators use "emulator-NNNN", physical devices use serial numbers
	if (
		deviceId.startsWith("emulator-") ||
		/^[A-Z0-9]+$/.test(deviceId) ||
		deviceId.includes(":")
	) {
		return "android";
	}

	return null;
}

/** Formats a Date into a filename-safe timestamp like 2026-03-28T17-32-21. */
function formatTimestamp(date: Date): string {
	return date
		.toISOString()
		.replace(/:/g, "-")
		.replace(/\.\d{3}Z$/, "");
}

/** Builds the default output path for a recording. */
async function buildOutputPath(
	platform: "ios" | "macos" | "android",
	projectPath: string,
	savePath?: string,
): Promise<string> {
	if (savePath) {
		await fs.mkdir(path.dirname(savePath), { recursive: true });
		return savePath;
	}

	const ext = platform === "macos" ? "mov" : "mp4";
	const timestamp = formatTimestamp(new Date());

	let prefix = "";
	const packageName = await readPackageName(projectPath);
	if (packageName) {
		prefix = `${packageName}_`;
	}

	const dir = path.join(os.tmpdir(), RECORDING_DIR);
	await fs.mkdir(dir, { recursive: true });
	return path.join(dir, `${prefix}recording_${timestamp}.${ext}`);
}

/**
 * Retrieves the macOS CoreGraphics Window ID for a Flutter desktop app.
 * Uses JXA (JavaScript for Automation) via osascript to query the Window Server
 * by PID. Falls back to null if the window can't be found.
 */
async function getMacOSWindowId(
	flutterProcess: Subprocess,
): Promise<string | null> {
	const pid = flutterProcess.pid;
	if (!pid) return null;

	try {
		// Find child processes of the Flutter daemon (the actual app window owner)
		const childResult = await execa("pgrep", ["-P", String(pid)], {
			reject: false,
		});
		const childPids =
			childResult.stdout?.trim().split("\n").filter(Boolean) || [];
		const pidsToCheck = [String(pid), ...childPids];

		// Use JXA to query CoreGraphics for windows owned by our process tree.
		// Layer 0 = normal application windows (excludes menubar, dock, etc.)
		const windowResult = await execa("osascript", [
			"-l",
			"JavaScript",
			"-e",
			`
				ObjC.import('CoreGraphics');
				ObjC.import('Cocoa');
				const pids = [${pidsToCheck.join(",")}];
				const windows = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0);
				const count = ObjC.castRefToObject(windows).count;
				let result = '';
				for (let i = 0; i < count; i++) {
					const entry = ObjC.castRefToObject(windows).objectAtIndex(i);
					const ownerPID = entry.objectForKey('kCGWindowOwnerPID');
					const layer = entry.objectForKey('kCGWindowLayer');
					if (layer.intValue === 0 && pids.indexOf(ownerPID.intValue) >= 0) {
						result = '' + entry.objectForKey('kCGWindowNumber').intValue;
						break;
					}
				}
				result;
			`,
		]);

		const windowId = windowResult.stdout?.trim();
		if (windowId && /^\d+$/.test(windowId)) {
			console.error(`Found macOS Window ID: ${windowId}`);
			return windowId;
		}
	} catch (err) {
		console.error(
			`Could not retrieve macOS Window ID: ${toExecErrorMessage(err)}`,
		);
	}

	return null;
}

// ─── Platform Spawners ──────────────────────────────────────────────────────

function spawnIOSRecording(
	deviceId: string,
	outputPath: string,
): RecordingProcess {
	console.error(
		`Starting iOS Simulator recording: xcrun simctl io ${deviceId} recordVideo --mask=black ${outputPath}`,
	);
	const proc = execa(
		"xcrun",
		["simctl", "io", deviceId, "recordVideo", "--mask=black", outputPath],
		{ stdio: "pipe" },
	);
	proc.catch(() => {}); // Prevent unhandled rejection on kill
	return proc;
}

/**
 * Spawns a macOS screen recording process targeting a specific window.
 *
 * IMPORTANT: execa() returns a Subprocess that is both a ChildProcess AND a
 * thenable (Promise). If returned directly from a `.then()` callback or even
 * an `async` function, JavaScript's Promise resolution will unwrap the thenable
 * and wait for the process to exit — blocking the caller forever. We avoid this
 * by looking up the window ID first, THEN spawning the process and returning it
 * from a synchronous wrapper that is not inside a `.then()` chain.
 */
async function spawnMacOSRecording(
	flutterProcess: Subprocess,
	outputPath: string,
): Promise<RecordingProcess> {
	const windowId = await getMacOSWindowId(flutterProcess);

	let proc: RecordingProcess;

	if (windowId) {
		console.error(
			`Starting macOS window recording (Window ID: ${windowId}): screencapture -l${windowId} -v ${outputPath}`,
		);
		const subprocess = execa(
			"screencapture",
			[`-l${windowId}`, "-v", outputPath],
			{
				stdio: "pipe",
			},
		);
		subprocess.catch(() => {}); // Prevent unhandled rejection on kill
		proc = subprocess;
	} else {
		// Fallback: full-screen recording
		console.error(
			`macOS Window ID not found, falling back to full-screen recording: screencapture -v ${outputPath}`,
		);
		const subprocess = execa("screencapture", ["-v", outputPath], {
			stdio: "pipe",
		});
		subprocess.catch(() => {}); // Prevent unhandled rejection on kill
		proc = subprocess;
	}

	// Return a plain-object wrapper to prevent Promise resolution from
	// unwrapping the thenable execa Subprocess.
	return {
		kill: (signal) => proc.kill(signal),
		get pid() {
			return proc.pid;
		},
		get exitCode() {
			return proc.exitCode;
		},
		on: (event, listener) => {
			proc.on(event, listener);
			return proc;
		},
	} as RecordingProcess;
}

function spawnAndroidRecording(deviceId: string): RecordingProcess {
	console.error(
		`Starting Android recording: adb -s ${deviceId} shell screenrecord ${ANDROID_DEVICE_RECORDING_PATH}`,
	);
	const proc = execa(
		"adb",
		["-s", deviceId, "shell", "screenrecord", ANDROID_DEVICE_RECORDING_PATH],
		{ stdio: "pipe" },
	);
	proc.catch(() => {}); // Prevent unhandled rejection on kill
	return proc;
}

// ─── Core Handlers ──────────────────────────────────────────────────────────

export async function handleStartRecording(args: { save_path?: string }) {
	const session = requireSession();

	if (activeRecording) {
		throw new Error(
			"A recording is already in progress. Call stop_recording first to finalize the current recording, " +
				"or call stop_app which will automatically save the recording before stopping.",
		);
	}

	if (!session.deviceId) {
		throw new Error(
			"Cannot determine the target device. The app session has no device ID. " +
				"Try stopping and restarting the app with an explicit device_id.",
		);
	}

	const platform = detectPlatform(session.deviceId);
	if (!platform) {
		throw new Error(
			`Screen recording is not supported for device '${session.deviceId}'. ` +
				"Supported targets: iOS Simulator (UUID), macOS Desktop ('macos'), Android emulator/device.",
		);
	}

	const outputPath = await buildOutputPath(
		platform,
		session.projectPath,
		args.save_path,
	);
	const format = platform === "macos" ? ("mov" as const) : ("mp4" as const);

	let recordingProcess: RecordingProcess;
	switch (platform) {
		case "ios":
			recordingProcess = spawnIOSRecording(session.deviceId, outputPath);
			break;
		case "macos":
			recordingProcess = await spawnMacOSRecording(session.process, outputPath);
			break;
		case "android":
			recordingProcess = spawnAndroidRecording(session.deviceId);
			break;
	}

	// Safety timeout: auto-stop after MAX_RECORDING_DURATION_MS
	const autoStopTimer = setTimeout(async () => {
		console.error(
			`Recording auto-stopped after ${MAX_RECORDING_DURATION_MS / 1000}s safety limit.`,
		);
		await stopActiveRecordingIfRunning();
	}, MAX_RECORDING_DURATION_MS);

	setActiveRecording({
		process: recordingProcess,
		outputPath,
		format,
		platform,
		startedAt: Date.now(),
		autoStopTimer,
		deviceId: session.deviceId,
	});

	const platformLabel =
		platform === "ios"
			? "iOS Simulator"
			: platform === "macos"
				? "macOS Desktop"
				: "Android";

	const durationNote =
		platform === "android"
			? " Note: Android has a 180-second recording limit."
			: "";

	return textResponse(
		`Recording started on ${platformLabel}.${durationNote} ` +
			`Output will be saved to: ${outputPath}. ` +
			`Call stop_recording when done, or stop_app to auto-finalize.`,
	);
}

export async function handleStopRecording() {
	if (!activeRecording) {
		throw new Error(
			"No recording in progress. Use start_recording first to begin recording the app's screen.",
		);
	}

	const result = await finalizeRecording(activeRecording);
	return textResponse(JSON.stringify(result, null, 2));
}

/**
 * Safely stops any active recording without throwing.
 * Called by handleStopApp to auto-finalize before tearing down the session.
 */
export async function stopActiveRecordingIfRunning(): Promise<void> {
	if (!activeRecording) return;

	try {
		const result = await finalizeRecording(activeRecording);
		console.error(
			`Auto-finalized recording: ${result.recording_path} (${result.duration_seconds}s, ${result.format})`,
		);
	} catch (err) {
		console.error(
			`Failed to auto-finalize recording: ${toExecErrorMessage(err)}`,
		);
	}
}

// ─── Finalization ───────────────────────────────────────────────────────────

interface RecordingResult {
	status: string;
	recording_path: string;
	format: string;
	duration_seconds: number;
	file_size_bytes: number;
}

async function finalizeRecording(
	recording: ActiveRecording,
): Promise<RecordingResult> {
	clearTimeout(recording.autoStopTimer);

	const durationSeconds = Math.round((Date.now() - recording.startedAt) / 1000);

	// Gracefully stop the recording process
	await stopRecordingProcess(recording);

	// For Android, pull the file from the device to the host
	if (recording.platform === "android") {
		await pullAndroidRecording(recording.deviceId, recording.outputPath);
	}

	// Verify the output file exists and has content
	let fileSizeBytes = 0;
	try {
		const stat = await fs.stat(recording.outputPath);
		fileSizeBytes = stat.size;
	} catch {
		setActiveRecording(null);
		throw new Error(
			`Recording file was not created at ${recording.outputPath}. ` +
				"The recording process may have failed. Check that the target device is still running " +
				"and that you have the necessary permissions (macOS: System Settings → Privacy → Screen Recording).",
		);
	}

	if (fileSizeBytes === 0) {
		setActiveRecording(null);
		throw new Error(
			`Recording file at ${recording.outputPath} is empty (0 bytes). ` +
				"This usually means the recording was stopped before any frames were captured, " +
				"or on macOS, the terminal lacks Screen Recording permission. " +
				"Check System Settings → Privacy & Security → Screen Recording.",
		);
	}

	setActiveRecording(null);

	return {
		status: "success",
		recording_path: recording.outputPath,
		format: recording.format,
		duration_seconds: durationSeconds,
		file_size_bytes: fileSizeBytes,
	};
}

async function stopRecordingProcess(recording: ActiveRecording): Promise<void> {
	const proc = recording.process;

	// Check if already exited
	if (proc.exitCode !== null && proc.exitCode !== undefined) {
		console.error(
			`Recording process already exited with code ${proc.exitCode}`,
		);
		return;
	}

	// Send SIGINT for graceful finalization (writes moov atom for MP4/MOV)
	console.error("Sending SIGINT to recording process for graceful stop...");
	proc.kill("SIGINT");

	// Wait for the process to exit gracefully
	const exitPromise = new Promise<boolean>((resolve) => {
		proc.on("exit", () => resolve(true));
		setTimeout(() => resolve(false), GRACEFUL_STOP_WAIT_MS);
	});

	const exited = await exitPromise;

	if (!exited) {
		console.error(
			"Recording process did not exit after SIGINT, sending SIGKILL...",
		);
		proc.kill("SIGKILL");
	}
}

async function pullAndroidRecording(
	deviceId: string,
	outputPath: string,
): Promise<void> {
	console.error(
		`Pulling recording from Android device: adb -s ${deviceId} pull ${ANDROID_DEVICE_RECORDING_PATH} ${outputPath}`,
	);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });

	try {
		await execa("adb", [
			"-s",
			deviceId,
			"pull",
			ANDROID_DEVICE_RECORDING_PATH,
			outputPath,
		]);
	} catch (err) {
		throw new Error(
			`Failed to pull recording from Android device: ${toExecErrorMessage(err)}. ` +
				"The recording file may still exist on the device at " +
				`${ANDROID_DEVICE_RECORDING_PATH}. You can pull it manually with: ` +
				`adb -s ${deviceId} pull ${ANDROID_DEVICE_RECORDING_PATH} .`,
		);
	}

	// Clean up the device file
	try {
		await execa("adb", [
			"-s",
			deviceId,
			"shell",
			"rm",
			"-f",
			ANDROID_DEVICE_RECORDING_PATH,
		]);
	} catch {
		console.error(
			"Warning: Could not clean up recording file on Android device.",
		);
	}
}
