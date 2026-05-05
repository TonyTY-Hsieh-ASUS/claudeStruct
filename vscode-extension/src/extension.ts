/**
 * VS Code extension entry point (W7.1).
 *
 * Five commands:
 *   - claudestruct.review   (right-click on file/editor, or palette)
 *   - claudestruct.dev      (palette; prompts for description)
 *   - claudestruct.plan     (palette; prompts for description)
 *   - claudestruct.debug    (palette; prompts for description)
 *   - claudestruct.dashboard (palette; runs `cs dashboard --json`,
 *                              renders in a webview-less Markdown
 *                              preview to keep the extension lean).
 *
 * Output streams to a single `claudeStruct` OutputChannel — every
 * command appends a header banner so multiple runs are easy to tell
 * apart. We deliberately don't open a webview: the CLI's Rich output
 * works fine in the panel and skipping the WebView API keeps the
 * extension activation cost trivial.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import { buildArgs, runCs, type CliConfig, type CsTask } from "./runner.js";

const CHANNEL_NAME = "claudeStruct";


function loadConfig(): CliConfig {
  const cfg = vscode.workspace.getConfiguration("claudestruct");
  return {
    cliPath: cfg.get<string>("cliPath", "cs"),
    maxBytes: cfg.get<number>("maxBytes", 0),
    effort: cfg.get<string>("effort", ""),
    extraArgs: cfg.get<string[]>("extraArgs", []),
  };
}


function pickWorkspaceFolder(uri?: vscode.Uri): string | undefined {
  // When invoked from the explorer/editor context menu, prefer the
  // folder that owns the clicked resource so multi-root workspaces
  // run `cs` against the right repo.
  if (uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0]!.uri.fsPath;
  }
  return undefined;
}


/**
 * Compute the path arg(s) we should forward to `cs`. When invoked
 * from the explorer with multi-select, VS Code passes the focused
 * uri as `uri` and the selection as the second arg; we consume both.
 */
function pathsFromInvocation(
  uri?: vscode.Uri,
  selected?: vscode.Uri[],
  cwd?: string,
): string[] {
  const all: vscode.Uri[] = [];
  if (Array.isArray(selected) && selected.length > 0) {
    all.push(...selected);
  } else if (uri) {
    all.push(uri);
  }
  if (!cwd) {
    return all.map((u) => u.fsPath);
  }
  return all.map((u) => {
    const rel = path.relative(cwd, u.fsPath);
    // If the file lives outside the workspace folder for some reason,
    // fall back to the absolute path so the CLI can still find it.
    return rel.startsWith("..") || path.isAbsolute(rel) ? u.fsPath : rel;
  });
}


async function promptDescription(task: CsTask): Promise<string | undefined> {
  return await vscode.window.showInputBox({
    prompt: `claudeStruct ${task}: describe what you want`,
    placeHolder: task === "debug"
      ? "Paste the error message or describe the failure"
      : task === "plan"
      ? "What are you planning to build?"
      : task === "dev"
      ? "What change do you want to make?"
      : "(optional) override the default review prompt",
    ignoreFocusOut: true,
  });
}


async function executeTask(
  task: CsTask,
  channel: vscode.OutputChannel,
  uri?: vscode.Uri,
  selected?: vscode.Uri[],
): Promise<void> {
  const cfg = loadConfig();
  const cwd = pickWorkspaceFolder(uri);
  if (!cwd) {
    vscode.window.showErrorMessage(
      "claudeStruct: no workspace folder open. Open a folder first.",
    );
    return;
  }

  let description: string | undefined;
  if (task === "review") {
    // Review can run with an empty description (defaults to the
    // standard review prompt). We DON'T prompt unless the user
    // explicitly invokes via palette without a target — context-menu
    // invocations should be one click.
    description = "";
  } else {
    description = await promptDescription(task);
    if (description === undefined) {
      // User hit Esc.
      return;
    }
    if (description.trim().length === 0) {
      vscode.window.showErrorMessage(
        `claudeStruct ${task}: description is required.`,
      );
      return;
    }
  }

  const paths = pathsFromInvocation(uri, selected, cwd);
  let args: string[];
  try {
    args = buildArgs({ task, description, paths, config: cfg });
  } catch (err) {
    vscode.window.showErrorMessage(
      `claudeStruct: ${(err as Error).message}`,
    );
    return;
  }

  channel.show(true);
  channel.appendLine("");
  channel.appendLine(`────── cs ${task} ──────`);
  channel.appendLine(`$ ${cfg.cliPath} ${args.map(quoteArg).join(" ")}`);
  channel.appendLine("");

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `claudeStruct ${task}`,
      cancellable: false,
    },
    async () => {
      try {
        const result = await runCs(cfg.cliPath, args, cwd, (text) => {
          channel.append(text);
        });
        channel.appendLine("");
        channel.appendLine(
          `────── cs ${task} exited ${result.exitCode ?? "?"} ──────`,
        );
        if (result.exitCode !== 0) {
          vscode.window.showWarningMessage(
            `claudeStruct ${task} exited with code ${result.exitCode ?? "?"}; see output panel.`,
          );
        }
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        channel.appendLine(`! spawn failed: ${msg}`);
        vscode.window.showErrorMessage(
          `claudeStruct: failed to run ${cfg.cliPath} — ${msg}`,
        );
      }
    },
  );
}


/** Quote arg only when it contains shell-significant chars; keeps the
 *  echoed command line readable for the common case. */
function quoteArg(arg: string): string {
  if (/^[\w@./:=-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}


export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel(CHANNEL_NAME);
  context.subscriptions.push(channel);

  const tasks: CsTask[] = ["review", "dev", "plan", "debug"];
  for (const task of tasks) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `claudestruct.${task}`,
        (uri?: vscode.Uri, selected?: vscode.Uri[]) =>
          executeTask(task, channel, uri, selected),
      ),
    );
  }

  // Dashboard is a passive read; no description, no path forwarding.
  context.subscriptions.push(
    vscode.commands.registerCommand("claudestruct.dashboard", async () => {
      const cfg = loadConfig();
      const cwd = pickWorkspaceFolder();
      if (!cwd) {
        vscode.window.showErrorMessage(
          "claudeStruct: no workspace folder open.",
        );
        return;
      }
      channel.show(true);
      channel.appendLine("");
      channel.appendLine("────── cs dashboard ──────");
      try {
        const result = await runCs(cfg.cliPath, ["dashboard"], cwd, (t) =>
          channel.append(t),
        );
        if (result.exitCode !== 0) {
          vscode.window.showWarningMessage(
            `claudeStruct dashboard exited ${result.exitCode}; see output panel.`,
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `claudeStruct: failed to run cs dashboard — ${(err as Error).message}`,
        );
      }
    }),
  );
}


export function deactivate(): void {
  /* nothing to clean up — OutputChannel + commands are auto-disposed
   * via the subscription array. */
}
