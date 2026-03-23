import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// ─── Shared Schema Fragments ────────────────────────────────────────────────

const TARGET_DESCRIPTION =
	"Target string (e.g. '#loginBtn', 'text=\"Submit\"', 'type=\"ElevatedButton\"', 'id=\"123\"')";

function targetSchema(
	extras: Record<string, object> = {},
	required: string[] = [],
): Tool["inputSchema"] {
	return {
		type: "object",
		properties: {
			target: { type: "string", description: TARGET_DESCRIPTION },
			// Legacy fallbacks for backward compatibility
			finderType: { type: "string" },
			key: { type: "string" },
			text: { type: "string" },
			tooltip: { type: "string" },
			type: { type: "string" },
			...extras,
		},
		...(required.length > 0 ? { required } : {}),
	};
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const TOOL_DEFINITIONS: Tool[] = [
	// ── Lifecycle ──────────────────────────────────────────────────────────────

	{
		name: "start_app",
		description: "Injects the harness and starts the Flutter app in test mode.",
		inputSchema: {
			type: "object",
			properties: {
				project_path: {
					type: "string",
					description: "Absolute path to the Flutter project root",
				},
				device_id: {
					type: "string",
					description: "Device ID (e.g., 'macos', 'chrome', or a simulator ID)",
				},
			},
			required: ["project_path"],
		},
	},
	{
		name: "stop_app",
		description: "Stops the currently running Flutter app and cleans up.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "pilot_hot_restart",
		description:
			"Performs a hot restart of the currently running app session started by this server. " +
			"Prefer using the official MCP 'hot_restart' if connected to DTD.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "list_devices",
		description:
			"Lists available Flutter devices (simulators, emulators, physical devices, desktop). " +
			"Does NOT require a running app.",
		inputSchema: { type: "object", properties: {} },
	},

	// ── Interaction ────────────────────────────────────────────────────────────

	{
		name: "tap",
		description: "Taps on a widget identified by the target string.",
		inputSchema: targetSchema(),
	},
	{
		name: "enter_text",
		description: "Enters text into a widget found by the target string.",
		inputSchema: targetSchema(
			{
				text: { type: "string", description: "Text to enter" },
				action: {
					type: "string",
					description:
						"Optional TextInputAction to perform after entering text " +
						"(e.g. 'done', 'search', 'next', 'go', 'send').",
				},
			},
			["text"],
		),
	},
	{
		name: "scroll",
		description: "Scrolls a widget.",
		inputSchema: targetSchema(
			{
				dx: { type: "number", description: "Horizontal scroll delta" },
				dy: { type: "number", description: "Vertical scroll delta" },
			},
			["dx", "dy"],
		),
	},
	{
		name: "scroll_until_visible",
		description:
			"Scrolls a scrollable widget until a target widget is visible.",
		inputSchema: targetSchema({
			dy: {
				type: "number",
				description: "Vertical scroll delta per step (default 50.0)",
			},
			scrollable_target: {
				type: "string",
				description: "Optional target string for the scrollable container",
			},
		}),
	},
	{
		name: "wait_for",
		description: "Waits for a widget to appear.",
		inputSchema: targetSchema({
			timeout: { type: "number", description: "Timeout in milliseconds" },
		}),
	},

	// ── Inspection ─────────────────────────────────────────────────────────────

	{
		name: "get_widget_tree",
		description: "Returns a JSON representation of the widget tree.",
		inputSchema: {
			type: "object",
			properties: {
				summaryOnly: {
					type: "boolean",
					description:
						"If true, returns a filtered tree hiding layout clutter (Container, Padding, etc.)",
				},
			},
		},
	},
	{
		name: "get_accessibility_tree",
		description: "Returns the accessibility (semantics) tree.",
		inputSchema: {
			type: "object",
			properties: {
				includeRect: {
					type: "boolean",
					description:
						"If true, includes token-heavy coordinate and transform data for every node. Default is false.",
				},
			},
		},
	},
	{
		name: "explore_screen",
		description: "Maps out interactive elements on the screen.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "take_screenshot",
		description: "Captures a screenshot of the running app.",
		inputSchema: {
			type: "object",
			properties: {
				save_path: {
					type: "string",
					description:
						"Optional path to save the screenshot file (e.g. 'screenshot.png'). If not provided, returns base64.",
				},
				type: {
					type: "string",
					enum: ["device", "skia", "app"],
					default: "app",
					description:
						"The type of screenshot to retrieve. " +
						"'app' (default): Renders the current Flutter frame to PNG (recommended for vision). " +
						"'device': Native device screenshot (might fail on desktop or capture home screen). " +
						"'skia': Skia picture (vector, not PNG, NOT for AI vision).",
				},
			},
		},
	},

	// ── Assertions ─────────────────────────────────────────────────────────────

	{
		name: "assert_exists",
		description: "Returns { success: true } if the target exists.",
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", description: TARGET_DESCRIPTION },
			},
			required: ["target"],
		},
	},
	{
		name: "assert_not_exists",
		description: "Returns { success: true } if the target does NOT exist.",
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", description: TARGET_DESCRIPTION },
			},
			required: ["target"],
		},
	},
	{
		name: "assert_text_equals",
		description: "Returns { success: true } if the target text matches.",
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", description: TARGET_DESCRIPTION },
				expectedText: { type: "string" },
			},
			required: ["target", "expectedText"],
		},
	},
	{
		name: "assert_state",
		description:
			"Returns { success: true } if the target state (e.g. Checkbox value) matches.",
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", description: TARGET_DESCRIPTION },
				stateKey: { type: "string", description: "e.g. 'value', 'groupValue'" },
				expectedValue: { type: "boolean", description: "Expected bool value" },
			},
			required: ["target", "stateKey", "expectedValue"],
		},
	},

	// ── Navigation & Environment ───────────────────────────────────────────────

	{
		name: "navigate_to",
		description: "Pushes a named route using the root Navigator.",
		inputSchema: {
			type: "object",
			properties: {
				route: {
					type: "string",
					description: "Named route to navigate to (e.g. '/settings')",
				},
			},
			required: ["route"],
		},
	},
	{
		name: "intercept_network",
		description: "Mocks a network response. Pass null for both to clear.",
		inputSchema: {
			type: "object",
			properties: {
				urlPattern: { type: "string" },
				responseBody: { type: "string" },
			},
		},
	},
	{
		name: "simulate_background",
		description:
			"Simulates the app going into the background and coming back to the foreground.",
		inputSchema: {
			type: "object",
			properties: {
				duration_ms: {
					type: "number",
					description:
						"How long to keep the app in the background (default: 2000)",
				},
			},
		},
	},
	{
		name: "set_network_status",
		description:
			"Simulates network connectivity changes (macOS/iOS Simulator only right now).",
		inputSchema: {
			type: "object",
			properties: {
				wifi: { type: "boolean", description: "Enable or disable WiFi" },
			},
			required: ["wifi"],
		},
	},

	// ── Utilities ──────────────────────────────────────────────────────────────

	{
		name: "read_logs",
		description: "Reads the last N lines from the app's stdout/stderr.",
		inputSchema: {
			type: "object",
			properties: {
				lines: {
					type: "number",
					description: "Number of lines to read (default 50)",
				},
			},
		},
	},
	{
		name: "validate_project",
		description:
			"Checks and optionally fixes project prerequisites (dependencies, permissions).",
		inputSchema: {
			type: "object",
			properties: {
				project_path: {
					type: "string",
					description: "Absolute path to the Flutter project root",
				},
				auto_fix: {
					type: "boolean",
					description: "Whether to automatically apply fixes",
				},
			},
			required: ["project_path"],
		},
	},
];
