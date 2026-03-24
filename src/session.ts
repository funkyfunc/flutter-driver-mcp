import type { AppSession } from "./types.js";
import { MAX_LOG_LINES } from "./types.js";

export let activeAppSession: AppSession | null = null;
export let appConnectedResolver: (() => void) | null = null;
export const recentDaemonLogs: string[] = [];

export function appendLog(message: string): void {
	if (recentDaemonLogs.length >= MAX_LOG_LINES) recentDaemonLogs.shift();
	recentDaemonLogs.push(message);
}

export function requireSession(): AppSession {
	if (!activeAppSession)
		throw new Error("App is not running. Use start_app first.");
	return activeAppSession;
}

export function setActiveAppSession(session: AppSession | null): void {
	activeAppSession = session;
}

export function setAppConnectedResolver(resolver: (() => void) | null): void {
	appConnectedResolver = resolver;
}
