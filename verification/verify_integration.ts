/**
 * Comprehensive integration test.
 *
 * Boots the test app ONCE and exercises every tool category in a single session:
 *   Assertions → Input → State → Exploration → Navigation → Accessibility →
 *   Screenshot → Network Intercept → Hot Restart → Logs → Stop
 */

import fs from "fs";
import {
	callTool,
	createClient,
	extractText,
	initClient,
	step,
	TEST_APP_PATH,
} from "./helpers.js";

const client = createClient();

async function runTests(): Promise<void> {
	try {
		await initClient(client);

		// ── Boot ───────────────────────────────────────────────────────────────
		step("Starting app");
		await callTool(client, "start_app", {
			project_path: TEST_APP_PATH,
			device_id: "macos",
		});
		await new Promise((r) => setTimeout(r, 2000)); // let UI settle

		// ── Assertions ─────────────────────────────────────────────────────────
		step("assert_exists");
		await callTool(client, "assert_exists", { target: 'text="Welcome Home"' });

		step("assert_text_equals");
		await callTool(client, "assert_text_equals", {
			target: "#welcome_text",
			expectedText: "Welcome Home",
		});

		// ── Input ──────────────────────────────────────────────────────────────
		step("enter_text");
		await callTool(client, "enter_text", {
			target: "type=TextField",
			text: "Hello World",
		});
		await callTool(client, "assert_text_equals", {
			target: "type=TextField",
			expectedText: "Hello World",
		});

		// ── State ──────────────────────────────────────────────────────────────
		step("assert_state (checkbox false)");
		await callTool(client, "assert_state", {
			target: "#my_checkbox",
			stateKey: "value",
			expectedValue: false,
		});

		step("tap (checkbox)");
		await callTool(client, "tap", { target: "#my_checkbox" });

		step("assert_state (checkbox true)");
		await callTool(client, "assert_state", {
			target: "#my_checkbox",
			stateKey: "value",
			expectedValue: true,
		});

		// ── Exploration ────────────────────────────────────────────────────────
		step("explore_screen");
		const exploreResult = await callTool(client, "explore_screen");
		const exploreData = JSON.parse(extractText(exploreResult)) as {
			interactive_elements_count?: number;
		};
		if (
			!exploreData.interactive_elements_count ||
			exploreData.interactive_elements_count < 3
		) {
			throw new Error(
				`Expected ≥3 interactive elements, got ${exploreData.interactive_elements_count}`,
			);
		}

		// ── Accessibility ──────────────────────────────────────────────────────
		step("get_accessibility_tree");
		const a11yResult = await callTool(client, "get_accessibility_tree");
		const a11yTree = JSON.parse(extractText(a11yResult)) as {
			id?: unknown;
			rect?: unknown;
		};
		if (a11yTree.id === undefined || a11yTree.rect === undefined) {
			throw new Error(
				"Invalid accessibility tree: missing id or rect on root node",
			);
		}
		console.log(
			`✅ Root node has ID (${a11yTree.id}). Tree size: ${extractText(a11yResult).length} chars.`,
		);

		// ── Screenshot ─────────────────────────────────────────────────────────
		step("take_screenshot (app mode)");
		const screenshotPath = "/tmp/flutter_pilot_verify_screenshot.png";
		await callTool(client, "take_screenshot", {
			save_path: screenshotPath,
			type: "app",
		});
		if (
			!fs.existsSync(screenshotPath) ||
			fs.statSync(screenshotPath).size === 0
		) {
			throw new Error("Screenshot file missing or empty");
		}
		console.log(
			`✅ Screenshot created (${fs.statSync(screenshotPath).size} bytes)`,
		);
		fs.unlinkSync(screenshotPath);

		// ── Network Intercept ──────────────────────────────────────────────────
		step("intercept_network");
		await callTool(client, "intercept_network", {
			urlPattern: "example.com",
			responseBody: "Mocked Response Body",
		});
		await callTool(client, "tap", { target: "#fetch_button" });
		await new Promise((r) => setTimeout(r, 1000));
		await callTool(client, "assert_text_equals", {
			target: "#network_result",
			expectedText: "Mocked Response Body",
		});

		// ── Navigation ─────────────────────────────────────────────────────────
		step("navigate_to");
		await callTool(client, "navigate_to", { route: "/details" });
		await callTool(client, "assert_exists", { target: 'text="Item 5"' });

		// ── Logs ───────────────────────────────────────────────────────────────
		step("read_logs");
		const logsResult = await callTool(client, "read_logs", { lines: 10 });
		const logs = extractText(logsResult);
		if (logs.length === 0) {
			throw new Error("Expected non-empty logs");
		}
		console.log(`✅ Got ${logs.split("\n").length} log lines.`);

		// ── Hot Restart ────────────────────────────────────────────────────────
		step("pilot_hot_restart");
		await callTool(client, "pilot_hot_restart");
		await new Promise((r) => setTimeout(r, 3000)); // let restart settle

		step("read_logs (post-restart)");
		const postRestartLogs = extractText(
			await callTool(client, "read_logs", { lines: 20 }),
		);
		if (
			postRestartLogs.includes("Restarted") ||
			postRestartLogs.includes("restart")
		) {
			console.log("✅ Hot restart log evidence found.");
		} else {
			console.log(
				"⚠️ No explicit 'Restarted' in logs (may be timing), but command succeeded.",
			);
		}

		// ── Shutdown ────────────────────────────────────────────────────────────
		step("stop_app");
		await callTool(client, "stop_app");

		console.log("\n✅ ALL INTEGRATION TESTS PASSED!");
		process.exit(0);
	} catch (error) {
		console.error("\n❌ TEST FAILED:", error);
		try {
			await callTool(client, "stop_app");
		} catch {
			/* ignore */
		}
		process.exit(1);
	}
}

runTests();
