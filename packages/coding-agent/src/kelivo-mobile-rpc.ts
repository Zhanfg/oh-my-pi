/**
 * KELIVO mobile RPC launcher.
 *
 * This is intentionally not a general-purpose OMP CLI. Android hosts OMP as a
 * long-lived JSONL RPC engine, so pulling the interactive CLI/TUI command graph
 * into the standalone Bun executable wastes package size and startup memory.
 *
 * Keep this entrypoint narrow and fail closed on unknown flags. KELIVO owns the
 * user-facing UI, model bridge, permissions, workspace lifecycle and updates.
 */
import { getAgentDir, VERSION } from "@oh-my-pi/pi-utils/dirs";
import { setInteractiveHost } from "@oh-my-pi/pi-utils/env";
import { Settings } from "./config/settings";
import { runRpcMode } from "./modes/rpc/rpc-mode";
import { createAgentSession } from "./sdk";
import { SessionManager } from "./session/session-manager";
import { resolvePromptInput } from "./system-prompt";

type ApprovalMode = "always-ask" | "write" | "yolo";

interface MobileRpcArgs {
	sessionDir?: string;
	appendSystemPrompt?: string;
	model?: string;
	tools?: string[];
	approvalMode: ApprovalMode;
	version: boolean;
	help: boolean;
	smokeTest: boolean;
}

const HELP = `KELIVO OMP mobile runtime

Usage:
  omp --mode rpc --session-dir <dir> [options]

KELIVO RPC options:
  --model <provider/model>
  --tools <a,b,c>
  --append-system-prompt <text-or-file>
  --approval-mode <always-ask|write|yolo>
  --auto-approve, --yolo
  --no-pty
  --no-title
  --version
  --smoke-test
`;

function takeValue(argv: readonly string[], index: number, name: string): [string, number] {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
	return [value, index + 1];
}

function parseApprovalMode(value: string): ApprovalMode {
	if (value === "always-ask" || value === "write" || value === "yolo") return value;
	throw new Error(`Invalid --approval-mode: ${value}`);
}

function parseArgs(argv: readonly string[]): MobileRpcArgs {
	const result: MobileRpcArgs = {
		approvalMode: "always-ask",
		version: false,
		help: false,
		smokeTest: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--version" || arg === "-v") {
			result.version = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			result.help = true;
			continue;
		}
		if (arg === "--smoke-test") {
			result.smokeTest = true;
			continue;
		}
		if (arg === "--auto-approve" || arg === "--yolo") {
			result.approvalMode = "yolo";
			continue;
		}
		if (arg === "--no-pty" || arg === "--no-title") {
			// KELIVO enforces both regardless; accept the upstream spellings so
			// launchers can remain forward/backward compatible.
			continue;
		}
		if (arg === "--mode") {
			const [value, next] = takeValue(argv, i, "--mode");
			if (value !== "rpc" && value !== "rpc-ui") {
				throw new Error("KELIVO mobile runtime supports RPC mode only");
			}
			i = next;
			continue;
		}
		if (arg.startsWith("--mode=")) {
			const value = arg.slice("--mode=".length);
			if (value !== "rpc" && value !== "rpc-ui") {
				throw new Error("KELIVO mobile runtime supports RPC mode only");
			}
			continue;
		}
		if (arg === "--session-dir") {
			const [value, next] = takeValue(argv, i, "--session-dir");
			result.sessionDir = value;
			i = next;
			continue;
		}
		if (arg.startsWith("--session-dir=")) {
			result.sessionDir = arg.slice("--session-dir=".length);
			continue;
		}
		if (arg === "--append-system-prompt") {
			const [value, next] = takeValue(argv, i, "--append-system-prompt");
			result.appendSystemPrompt = value;
			i = next;
			continue;
		}
		if (arg.startsWith("--append-system-prompt=")) {
			result.appendSystemPrompt = arg.slice("--append-system-prompt=".length);
			continue;
		}
		if (arg === "--model") {
			const [value, next] = takeValue(argv, i, "--model");
			result.model = value;
			i = next;
			continue;
		}
		if (arg.startsWith("--model=")) {
			result.model = arg.slice("--model=".length);
			continue;
		}
		if (arg === "--tools") {
			const [value, next] = takeValue(argv, i, "--tools");
			result.tools = value.split(",").map(tool => tool.trim()).filter(Boolean);
			i = next;
			continue;
		}
		if (arg.startsWith("--tools=")) {
			result.tools = arg
				.slice("--tools=".length)
				.split(",")
				.map(tool => tool.trim())
				.filter(Boolean);
			continue;
		}
		if (arg === "--approval-mode") {
			const [value, next] = takeValue(argv, i, "--approval-mode");
			result.approvalMode = parseApprovalMode(value);
			i = next;
			continue;
		}
		if (arg.startsWith("--approval-mode=")) {
			result.approvalMode = parseApprovalMode(arg.slice("--approval-mode=".length));
			continue;
		}
		throw new Error(`Unsupported KELIVO mobile OMP argument: ${arg}`);
	}

	return result;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.version) {
		process.stdout.write(`${VERSION}-kelivo-mobile\n`);
		return;
	}
	if (args.help) {
		process.stdout.write(HELP);
		return;
	}
	if (args.smokeTest) {
		process.stdout.write("kelivo-mobile-rpc: ok\n");
		return;
	}

	if (!args.sessionDir) throw new Error("--session-dir is required");

	// Headless classification changes SQLite busy timeouts and suppresses
	// interactive-only background behavior before any session database opens.
	setInteractiveHost(false);
	process.env.PI_NO_PTY = "1";
	process.env.PI_NOTIFICATIONS = "off";
	process.env.PI_SKIP_VERSION_CHECK = "1";

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settings = await Settings.init({ cwd, agentDir });
	settings.override("tools.approvalMode", args.approvalMode);
	settings.override("advisor.enabled", false);
	settings.override("memories.enabled", false);
	settings.override("computer.enabled", false);
	settings.override("speechgen.enabled", false);
	settings.override("generate_image.enabled", false);

	// KELIVO's Plan-first mode is represented by a forced first-turn todo plus
	// always-ask approval. The host then remains the approval authority.
	if (process.env.KELIVO_AGENT_PERMISSION_MODE === "planFirst") {
		settings.override("todo.eager", "always");
	}

	const sessionManager = SessionManager.create(cwd, args.sessionDir);
	const appendSystemPrompt = await resolvePromptInput(
		args.appendSystemPrompt,
		"KELIVO append system prompt",
	);

	const result = await createAgentSession({
		cwd,
		agentDir,
		settings,
		sessionManager,
		modelPattern: args.model,
		appendSystemPrompt,
		toolNames: args.tools,
		restrictToolNames: args.tools !== undefined,
		allowRestrictedCustomTools: false,
		enableLsp: args.tools?.includes("lsp") ?? true,
		enableMCP: true,
		autoApprove: args.approvalMode === "yolo",
		hasUI: false,
		interactivePrompts: true,
		skipPythonPreflight: true,
	});

	await runRpcMode(
		result.session,
		result.setToolUIContext,
		result.subagentEventBus,
	);
}

try {
	await main();
} catch (error) {
	const message = error instanceof Error ? error.stack ?? error.message : String(error);
	process.stderr.write(`KELIVO mobile OMP startup failed: ${message}\n`);
	process.exit(1);
}
