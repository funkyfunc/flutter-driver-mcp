/**
 * Smoke test: verifies the tool list schema is correct.
 * Does NOT boot the test app — runs in under a second.
 */

import { createClient, initClient, type McpTool } from "./helpers.js";

const EXPECTED_TOOLS = [
	"start_app",
	"stop_app",
	"pilot_hot_restart",
	"list_devices",
	"tap",
	"enter_text",
	"scroll",
	"scroll_until_visible",
	"wait_for",
	"get_widget_tree",
	"get_accessibility_tree",
	"explore_screen",
	"take_screenshot",
	"assert_exists",
	"assert_not_exists",
	"assert_text_equals",
	"assert_state",
	"navigate_to",
	"intercept_network",
	"simulate_background",
	"set_network_status",
	"read_logs",
	"validate_project",
];

async function main(): Promise<void> {
	const client = createClient();

	const res = await client.send("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "verify-tools", version: "1.0.0" },
	});

	const listRes = await client.send("tools/list", {});
	const tools = listRes.result?.tools ?? [];
	const toolNames = new Set(tools.map((t: McpTool) => t.name));

	let passed = true;
	for (const expected of EXPECTED_TOOLS) {
		if (!toolNames.has(expected)) {
			console.error(`❌ Missing tool: ${expected}`);
			passed = false;
		}
	}

	// Spot-check a specific property
	const getWidgetTree = tools.find(
		(t: McpTool) => t.name === "get_widget_tree",
	);
	if (!getWidgetTree?.inputSchema?.properties?.summaryOnly) {
		console.error("❌ get_widget_tree missing 'summaryOnly' property");
		passed = false;
	}

	if (passed) {
		console.log(
			`✅ All ${EXPECTED_TOOLS.length} expected tools found with correct schemas.`,
		);
	}

	client.cleanup();
	process.exit(passed ? 0 : 1);
}

main();
