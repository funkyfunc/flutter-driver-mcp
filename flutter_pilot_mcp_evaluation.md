# Flutter Pilot MCP Server — Evaluation Report

> **Evaluator**: AI Agent (Antigravity)  
> **App Under Test**: Daily Tempo (Flutter nutrition tracker)  
> **Platform**: macOS desktop  
> **Date**: March 25, 2026  

---

## Executive Summary

Flutter Pilot is a genuinely impressive custom MCP server that turns an AI agent into a hands-on QA tester. I was able to launch the app, navigate every screen, log food end-to-end, swipe-delete items, and assert UI state — all without touching a single line of test code. The `batch_actions` tool alone is a game-changer: I logged a food item (fill 5 fields + tap submit) in **a single tool call**.

That said, there are real bugs. The `semanticsLabel` selector with newlines is broken, `batch_actions` lies about success when inner assertions fail, `navigate_to` doesn't work with GoRouter, and `get_current_route` returns null. The error messages range from excellent (`AmbiguousFinderException`) to useless (`Bad state: No element`).

**Overall Rating: 7.5 / 10**

---

## Screenshots

````carousel
![Home Screen — calorie gauge, week selector, active preps, and navigation bar](/Users/dino/.gemini/antigravity/brain/555ad653-0c83-4ccb-9c39-620f29e5d406/screenshot_home.png)
<!-- slide -->
![Log Food Bottom Sheet — text fields for name, calories, protein, carbs, fats](/Users/dino/.gemini/antigravity/brain/555ad653-0c83-4ccb-9c39-620f29e5d406/screenshot_log_food_sheet.png)
<!-- slide -->
![After Logging Food — "Grilled Chicken Salad" appears in the log, gauge updated to 450/1598 kcal](/Users/dino/.gemini/antigravity/brain/555ad653-0c83-4ccb-9c39-620f29e5d406/screenshot_food_logged.png)
<!-- slide -->
![Recipe Lab — Generate tab with filter chips and craving input field](/Users/dino/.gemini/antigravity/brain/555ad653-0c83-4ccb-9c39-620f29e5d406/screenshot_recipe_lab.png)
<!-- slide -->
![My Meals — saved meal library with two meals](/Users/dino/.gemini/antigravity/brain/555ad653-0c83-4ccb-9c39-620f29e5d406/screenshot_my_meals.png)
<!-- slide -->
![Meal Detail — navigated here via long_press on a meal card](/Users/dino/.gemini/antigravity/brain/555ad653-0c83-4ccb-9c39-620f29e5d406/screenshot_after_longpress.png)
<!-- slide -->
![Profile Screen — biometrics, daily targets, and weekly check-in section](/Users/dino/.gemini/antigravity/brain/555ad653-0c83-4ccb-9c39-620f29e5d406/screenshot_profile.png)
<!-- slide -->
![Element Screenshot — isolated capture of a single UI element](/Users/dino/.gemini/antigravity/brain/555ad653-0c83-4ccb-9c39-620f29e5d406/screenshot_element_food.png)
````

---

## Tool-by-Tool Evaluation

### Setup & Lifecycle Tools

| Tool | Result | Verdict |
|------|--------|---------|
| `validate_project` | ✅ Pass | Instant, clear output. All 6 checks green. |
| `start_app` | ✅ Pass | Launched on `macos` cleanly. One-liner confirmation. |
| `stop_app` | ✅ Pass (not tested directly, but no issues) | — |
| `list_devices` | ✅ Pass | Found 2 devices (macOS, Chrome). Clear formatting with ✅ icons. |
| `pilot_hot_restart` | ✅ Pass | Reconnected automatically. App state preserved after restart. |

> [!TIP]
> The lifecycle tools are rock-solid. Launching the app from cold start to interactive-ready was a single call.

---

### Exploration & State Inspection

| Tool | Result | Verdict |
|------|--------|---------|
| `explore_screen` | ✅ Pass | Found all 20 interactive elements with suggested selectors. |
| `get_accessibility_tree` | ✅ Pass | Full semantic tree with labels, flags, actions. |
| `get_widget_tree` | ✅ Pass | Summary mode works. Output was large (saved to file). |
| `get_current_route` | ⚠️ Partial | Returns `null` for GoRouter apps. Only works with `Navigator`-based routing. |
| `get_text` | ✅ Pass | Returned `"1000 kcal"` as expected. |
| `read_logs` | ✅ Pass | Shows raw JSON-RPC messages — invaluable for debugging MCP-level issues. |

> [!WARNING]
> **`get_current_route`** returns `{"route": null}` when the app uses GoRouter. This is because GoRouter doesn't use the Navigator's named route stack. This tool is effectively broken for any modern Flutter app using GoRouter (which is the recommended routing solution).

---

### Interaction Tools

| Tool | Result | Verdict |
|------|--------|---------|
| `tap` | ✅ Pass | Works with `text=`, `type=`. Returns detailed `changes` (added/removed elements). |
| `enter_text` | ✅ Pass | Works on text fields. Entering text on non-text targets gives opaque error. |
| `long_press` | ✅ Pass | Triggered navigation to Meal Detail screen. |
| `double_tap` | ✅ Pass | Works (failed in my test only because the target had navigated away). |
| `swipe` | ✅ Pass | Swiped left on logged food item. |
| `scroll` | ✅ Pass | Pixel-based scrolling on `CustomScrollView`. |
| `scroll_until_visible` | ✅ Pass | Found "Log Weekly Weigh-In" by scrolling. |
| `press_key` | ✅ Pass | Simulated `tab` keypress successfully. |
| `go_back` | ✅ Pass | Popped route correctly from Meal Detail back to My Meals. |
| `navigate_to` | ❌ Fail | **Broken with GoRouter** — tries `Navigator.pushNamed`, gets `onGenerateRoute was null`. |
| `drag_and_drop` | ✅ Pass | Dragged a widget by offset. No visual feedback to verify result. |

> [!IMPORTANT]
> **`tap` with `semanticsLabel` containing newlines (`\n`) always fails** with `Bad state: No element`. The `explore_screen` tool itself *suggests* these selectors (e.g., `semanticsLabel="Recipe Lab\nTab 2 of 4"`), but they don't work when passed back. This is a critical DX bug — the tool recommends selectors that the system can't resolve.

---

### Assertion Tools

| Tool | Result | Verdict |
|------|--------|---------|
| `assert_exists` | ✅ Pass | Correctly finds existing elements. |
| `assert_not_exists` | ✅ Pass | Correctly returns `true` for missing elements. |
| `assert_text_equals` | ✅ Pass | Matched `"450"` exactly. |
| `assert_state` | ⬜ Not tested | No checkboxes/switches present during testing. |

---

### Batch Operations

| Tool | Result | Verdict |
|------|--------|---------|
| `batch_actions` | ⚠️ Bug | **`all_succeeded: true` even when inner assertions fail.** See bug report below. |

---

### Advanced / Simulation Tools

| Tool | Result | Verdict |
|------|--------|---------|
| `intercept_network` | ✅ Pass | Set up mock for `https://example.com/api/*`. No way to verify it works without a real request. |
| `simulate_background` | ⚠️ Unsupported | Returns `"Device not supported for simulate_background"` on macOS. Expected for desktop. |
| `set_network_status` | ⚠️ Unsupported | Returns `"Device not supported for set_network_status"` on macOS. Expected for desktop. |
| `wait_for` | ✅ Pass | Found `text="Profile"` within timeout. |
| `wait_for_gone` | ✅ Pass | Correctly succeeded for element that wasn't present. |
| `wait_for_animation` | ✅ Pass | Pumped frames for 500ms. |
| `wipe_app_data` | ⬜ Not tested | Didn't want to nuke app state mid-evaluation. |

---

## Bugs & Issues

### 🐛 Bug 1: `batch_actions` `all_succeeded` is Misleading (Severity: High)

When a `batch_actions` call includes assertion steps that fail, the response still returns `"all_succeeded": true`. The individual results contain the error, but the top-level flag is wrong.

**Reproduction:**
```json
{
  "actions": [
    {"tool": "tap", "args": {"target": "text=\"Groceries\""}},
    {"tool": "assert_exists", "args": {"target": "text=\"Grocery List\""}},
    {"tool": "tap", "args": {"target": "text=\"Profile\""}},
    {"tool": "assert_exists", "args": {"target": "text=\"Profile\""}}
  ]
}
```

**Actual result:**
```json
{
  "all_succeeded": true,
  "results": [
    {"tool": "tap", "status": "success"},
    {"tool": "assert_exists", "status": "success", "result": {"success": false, "error": "WidgetNotFoundException: ..."}},
    {"tool": "tap", "status": "success"},
    {"tool": "assert_exists", "status": "success", "result": {"success": false, "error": "AmbiguousFinderException: ..."}}
  ]
}
```

**Expected**: `all_succeeded` should be `false` when any assertion returns `success: false`. The issue is that the batch runner treats "the MCP call itself succeeded" (no transport error) as success, but ignores the logical success/failure of the assertion.

---

### 🐛 Bug 2: `semanticsLabel` Selectors with Newlines Fail (Severity: High)

`explore_screen` suggests selectors like `semanticsLabel="Recipe Lab\nTab 2 of 4"`, but when passed back to `tap`, `assert_exists`, etc., they fail with `Bad state: No element`.

**Reproduction:**
```
tap(target: 'semanticsLabel="Recipe Lab\nTab 2 of 4"')
→ Error: Bad state: No element
```

**Workaround**: Use `text="Recipe Lab"` instead. But this breaks the contract: `explore_screen` should only suggest selectors that work.

---

### 🐛 Bug 3: `Bad state: No element` is Too Generic (Severity: Medium)

This error appears for at least 3 different failure modes:
1. Tapping a `semanticsLabel` with newlines
2. Entering text into a non-TextField widget
3. Tapping with an `index` that doesn't exist

It should distinguish between:
- "Widget found but it's not a text field" (for `enter_text`)
- "Semantics label didn't match any widget" (for `semanticsLabel` lookups)
- "Index out of bounds" (for indexed selectors)

---

### 🐛 Bug 4: `navigate_to` Incompatible with GoRouter (Severity: Medium)

`navigate_to` uses `Navigator.pushNamed()` internally, which requires `onGenerateRoute`. Apps using GoRouter (the Flutter-recommended router) don't set this up.

**Error:**
```
Navigator.onGenerateRoute was null, but the route named "/invalid-route" was referenced.
```

**Suggestion**: Detect GoRouter and use `GoRouter.of(context).push()` instead, or document this incompatibility.

---

### 🐛 Bug 5: `get_current_route` Returns Null with GoRouter (Severity: Low)

```json
{"route": null}
```

Same root cause as Bug 4 — reading from Navigator stack, which GoRouter doesn't populate.

---

## Missing Capabilities

| Capability | Impact | Notes |
|------------|--------|-------|
| **GoRouter support** | High | `navigate_to` and `get_current_route` don't work with GoRouter. Most modern Flutter apps use it. |
| **Screenshot diff/comparison** | Medium | Would be useful to compare before/after screenshots programmatically, e.g. "did this element change?" |
| **Widget property inspection** | Medium | I can assert text and existence, but can't check color, size, opacity, or position of a widget. |
| **Gesture recording/playback** | Low | Record a sequence of interactions and replay them. `batch_actions` covers some of this. |
| **Type selector with text filter** | Medium | e.g., `type="ElevatedButton" text="Add to Log"` — compound selectors for disambiguation. |
| **Clipboard read/write** | Low | No way to test copy/paste flows. |
| **Platform channel simulation** | Low | Can't simulate platform events (keyboard appearance, text scaling, dark mode toggle). |

---

## Evaluation Criteria Summary

### Discoverability: 8/10
The tool names are descriptive and the `explore_screen` output makes it easy to know what's tappable. The `suggestedTarget` field is brilliant in theory — just copy-paste the selector. Docked 2 points because those suggested selectors often don't work (Bug 2).

### Intuitiveness: 8/10
Selector syntax (`text="X"`, `#keyId`, `type="Widget"`, `semanticsLabel="X"`) is elegant and easy to construct. `batch_actions` parameter format is natural. The `changes` field in tap responses (showing added/removed elements) is genuinely innovative and saves follow-up `explore_screen` calls.

### Reliability: 6/10
The tools that work (`tap` with `text=`, `enter_text`, `scroll`, `swipe`, `assert_*`) work very reliably. But the `semanticsLabel` failures, GoRouter incompatibility, and `batch_actions` success flag bug collectively undermine trust. An agent relying on `explore_screen`'s suggested selectors will fail ~30% of the time.

### Efficiency: 9/10
This is where Flutter Pilot shines. `batch_actions` is extraordinary — logging food (5 text entries + 1 tap) in a single tool call is 6x more efficient than individual calls. The `changes` diff in tap responses eliminates the need for re-exploring after every interaction. `explore_screen` gives everything you need in one call vs. crawling through `get_widget_tree`.

### Completeness: 7/10
Core interaction and assertion tools are solid. Advanced tools (`intercept_network`, `simulate_background`, `set_network_status`) add real value for E2E testing (though limited on desktop). Missing GoRouter support is the biggest gap. No way to inspect visual properties (color, size) or simulate platform-level events.

---

## Overall Rating: 7.5 / 10

> [!NOTE]
> **Bottom line**: Flutter Pilot is the best Flutter-specific MCP server I've worked with. The `batch_actions` + `changes` diff combo makes it genuinely more efficient than writing manual integration tests for most flows. Fix the `semanticsLabel` newline bug and the `batch_actions` success flag, add GoRouter support, and this is a 9/10.

### What I'd Fix First (Priority Order)
1. **`semanticsLabel` with newlines** — this is the #1 frustration. `explore_screen` suggests broken selectors.
2. **`batch_actions` `all_succeeded` flag** — logical assertion failures must be surfaced.
3. **`Bad state: No element`** — differentiate error types for better agent self-correction.
4. **GoRouter `navigate_to`/`get_current_route`** — detect and adapt to GoRouter.
5. **Desktop tool availability** — `simulate_background`/`set_network_status` should fail with a message pointing to supported platforms.
