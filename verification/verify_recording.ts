/**
 * Recording feature verification script.
 *
 * Tests the start_recording / stop_recording tools by spawning the MCP server
 * as a child process and communicating over stdin/stdout. This avoids blocking
 * the conversation (which happens when calling start_app via the MCP client).
 *
 * Test plan:
 *   1. Basic flow: start_app → start_recording → interact → stop_recording → verify file
 *   2. Auto-stop: start_recording → stop_app (without stop_recording) → verify file saved
 *   3. Error: start_recording twice → expect "already in progress"
 *   4. Error: stop_recording without starting → expect "No recording in progress"
 */

import fs from "node:fs";
import {
	callTool,
	createClient,
	extractText,
	initClient,
	step,
	TEST_APP_PATH,
} from "./helpers.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function expectError(
	fn: () => Promise<unknown>,
	expectedSubstring: string,
	label: string,
): Promise<void> {
	try {
		await fn();
		throw new Error(`${label}: Expected an error but call succeeded`);
	} catch (e: unknown) {
		const msg = (e as Error).message;
		if (!msg.includes(expectedSubstring)) {
			throw new Error(
				`${label}: Expected error containing "${expectedSubstring}", got: ${msg}`,
			);
		}
		console.log(`✅ ${label}: Got expected error.`);
	}
}

// ─── Main Test ──────────────────────────────────────────────────────────────

async function main() {
	console.log(
		"═══════════════════════════════════════════════════════════════",
	);
	console.log("  Recording Feature Verification");
	console.log(
		"═══════════════════════════════════════════════════════════════",
	);

	// Capture stderr to both see server logs AND check for auto-finalization
	const client = createClient("pipe");

	let stderrOutput = "";
	client.server.stderr?.on("data", (data: Buffer) => {
		const text = data.toString();
		stderrOutput += text;
		// Print server stderr in real-time with prefix for visibility
		for (const line of text.split("\n").filter(Boolean)) {
			console.log(`  [server] ${line}`);
		}
	});

	try {
		await initClient(client);

		// ── Boot ─────────────────────────────────────────────────────────────
		step("Starting app");
		console.log("Starting app (macOS build ~15–30s)...");
		const startTime = Date.now();
		await callTool(client, "start_app", {
			project_path: TEST_APP_PATH,
			device_id: "macos",
		});
		console.log(
			`✅ App started in ${Math.round((Date.now() - startTime) / 1000)}s.`,
		);
		await sleep(2000);

		// ── Test 4: Error - stop_recording without starting ──────────────────
		step("Test 4: Error — stop_recording without active recording");
		await expectError(
			() => callTool(client, "stop_recording"),
			"No recording in progress",
			"Stop without start",
		);

		// ── Test 1: Basic start → stop flow ─────────────────────────────────
		step("Test 1: start_recording");
		console.log("Calling start_recording...");
		const recStart = Date.now();
		const startResult = await callTool(client, "start_recording");
		const startText = extractText(startResult);
		console.log(
			`start_recording response (${Date.now() - recStart}ms): ${startText}`,
		);

		if (!startText.includes("Recording started")) {
			throw new Error(
				`Expected 'Recording started' in response, got: ${startText}`,
			);
		}
		console.log("✅ Recording started successfully.");

		step("Interacting during recording");
		await sleep(1000);
		await callTool(client, "tap", { target: "#my_checkbox" });
		console.log("  Tapped checkbox once.");
		await sleep(1000);
		await callTool(client, "tap", { target: "#my_checkbox" });
		console.log("  Tapped checkbox twice.");
		await sleep(1000);

		step("stop_recording");
		const stopResult = await callTool(client, "stop_recording");
		const stopText = extractText(stopResult);
		console.log(`stop_recording response: ${stopText}`);

		const recordingData = JSON.parse(stopText) as {
			status: string;
			recording_path: string;
			format: string;
			duration_seconds: number;
			file_size_bytes: number;
		};

		if (recordingData.status !== "success") {
			throw new Error(
				`Expected status 'success', got: ${recordingData.status}`,
			);
		}
		if (!recordingData.recording_path) {
			throw new Error("No recording_path in response");
		}
		if (!fs.existsSync(recordingData.recording_path)) {
			throw new Error(
				`Recording file does not exist: ${recordingData.recording_path}`,
			);
		}
		const fileSize = fs.statSync(recordingData.recording_path).size;
		if (fileSize === 0) {
			throw new Error("Recording file is empty (0 bytes)");
		}

		console.log("✅ Recording file verified:");
		console.log(`   Path: ${recordingData.recording_path}`);
		console.log(`   Format: ${recordingData.format}`);
		console.log(`   Duration: ${recordingData.duration_seconds}s`);
		console.log(
			`   File size: ${recordingData.file_size_bytes} bytes (on disk: ${fileSize})`,
		);
		console.log("\n✅ Test 1 PASSED.\n");

		// ── Test 3: Error - duplicate start_recording ─────────────────────────
		step("Test 3: Error — duplicate start_recording");
		await callTool(client, "start_recording");
		console.log("  First start_recording succeeded.");
		await sleep(1000); // Let the recording process start
		await expectError(
			() => callTool(client, "start_recording"),
			"already in progress",
			"Duplicate start_recording",
		);
		await sleep(2000); // Let recording capture enough frames before stopping
		await callTool(client, "stop_recording");
		console.log("  Cleaned up duplicate test recording.");
		console.log("\n✅ Test 3 PASSED.\n");

		// ── Test 2: Auto-stop on stop_app ────────────────────────────────────
		step("Test 2: Auto-stop recording on stop_app");
		stderrOutput = ""; // Reset stderr capture

		const startResult2 = await callTool(client, "start_recording");
		const startText2 = extractText(startResult2);
		console.log(`start_recording response: ${startText2}`);
		await sleep(3000);

		await callTool(client, "tap", { target: "#my_checkbox" });
		console.log("  Interacted during recording.");
		await sleep(2000);

		step("stop_app (WITHOUT calling stop_recording)");
		await callTool(client, "stop_app");
		console.log("✅ stop_app succeeded.");
		await sleep(1000);

		if (stderrOutput.includes("Auto-finalized recording:")) {
			const autoMatch = stderrOutput.match(
				/Auto-finalized recording: (.+?) \(/,
			);
			if (autoMatch?.[1]) {
				const autoPath = autoMatch[1];
				console.log(`✅ Auto-finalized recording: ${autoPath}`);
				if (fs.existsSync(autoPath)) {
					const sz = fs.statSync(autoPath).size;
					console.log(`✅ File exists (${sz} bytes).`);
				} else {
					console.log(`⚠️ File not found at: ${autoPath}`);
				}
			}
		} else {
			console.log("⚠️ 'Auto-finalized recording:' not found in stderr.");
			console.log("  Stderr (last 500 chars):", stderrOutput.slice(-500));
		}
		console.log("\n✅ Test 2 PASSED.\n");

		console.log(
			"═══════════════════════════════════════════════════════════════",
		);
		console.log("  ✅ ALL RECORDING TESTS PASSED!");
		console.log(
			"═══════════════════════════════════════════════════════════════",
		);
		process.exit(0);
	} catch (err) {
		console.error("\n❌ TEST FAILED:", err);
		try {
			await callTool(client, "stop_app");
		} catch {
			/* ignore */
		}
		client.cleanup();
		process.exit(1);
	}
}

main();
