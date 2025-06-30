import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Waits briefly for shell integration to become available
 * @param terminal The terminal to wait for
 * @param timeout Maximum time to wait in milliseconds
 * @returns Promise that resolves to true if shell integration became available
 */
async function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeout = 1000
): Promise<boolean> {
  if (terminal.shellIntegration) {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    const timeoutId = setTimeout(() => {
      disposable.dispose();
      resolve(false);
    }, timeout);

    const disposable = vscode.window.onDidChangeTerminalShellIntegration(
      (e) => {
        if (e.terminal === terminal && terminal.shellIntegration) {
          clearTimeout(timeoutId);
          disposable.dispose();
          resolve(true);
        }
      }
    );
  });
}

/**
 * Executes a shell command using terminal shell integration
 * @param terminal The terminal with shell integration
 * @param command The command to execute
 * @param cwd Optional working directory for the command
 * @param timeout Command timeout in milliseconds (default: 180000 = 3 minutes)
 * @param longLived If true, command runs without timeout
 * @returns Promise that resolves with the command output
 */
export async function executeShellCommand(
  terminal: vscode.Terminal,
  command: string,
  cwd?: string,
  timeout: number = 180000,
  longLived: boolean = false
): Promise<{ output: string }> {
  terminal.show();

  // Build full command including cd if cwd is specified
  let fullCommand = command;
  if (cwd) {
    if (cwd === "." || cwd === "./") {
      fullCommand = `${command}`;
    } else {
      const quotedPath = cwd.includes(" ") ? `"${cwd}"` : cwd;
      fullCommand = `cd ${quotedPath} && ${command}`;
    }
  }

  // If longLived is true, start the command and return immediately
  if (longLived) {
    // Execute the command without waiting for completion
    terminal.shellIntegration!.executeCommand(fullCommand);

    // Return immediately with a message
    return {
      output: `Long-lived command started: ${command}\n\nThe command is now running in the terminal. Check the terminal for output.`,
    };
  }

  // For non-long-lived commands, wait for completion with timeout
  const executionPromise = async (): Promise<{ output: string }> => {
    // Execute the command using shell integration API
    const execution = terminal.shellIntegration!.executeCommand(fullCommand);

    // Capture output using the stream
    let output = "";

    try {
      // Access the read stream (handling possible API differences)
      const outputStream = (execution as any).read();
      for await (const data of outputStream) {
        output += data;
      }
    } catch (error) {
      throw new Error(`Failed to read command output: ${error}`);
    }

    return { output };
  };

  // Race between execution and timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Command timed out after ${timeout}ms`)),
      timeout
    );
  });

  return Promise.race([executionPromise(), timeoutPromise]);
}

/**
 * Registers MCP shell-related tools with the server
 * @param server MCP server instance
 * @param terminal The terminal to use for command execution
 */
export function registerShellTools(
  server: McpServer,
  terminal?: vscode.Terminal
): void {
  // Add execute_shell_command tool
  server.tool(
    "execute_shell_command_code",
    `Executes shell commands in VS Code integrated terminal.

        WHEN TO USE: Running CLI commands, builds, git operations, npm/pip installs.
        
        Working directory: Use cwd to run commands in specific directories. Defaults to workspace root. If you get unexpected results, ensure the cwd is correct.

        Timeout: Commands must complete within specified time (default 3 minutes) or the tool will return a timeout error, but the command may still be running in the terminal.
        
        Long-lived commands: Set longLived=true for commands that should run without waiting for completion (e.g., dev servers, watch processes).
        When longLived=true, the command starts and returns immediately. Check the terminal for ongoing output.`,
    {
      command: z.string().describe("The shell command to execute"),
      cwd: z
        .string()
        .optional()
        .default(".")
        .describe("Optional working directory for the command"),
      timeout: z
        .number()
        .optional()
        .default(180000)
        .describe(
          "Command timeout in milliseconds (default: 180000 = 3 minutes)"
        ),
      longLived: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, command runs without timeout"),
    },
    async ({
      command,
      cwd,
      timeout = 180000,
      longLived = false,
    }): Promise<CallToolResult> => {
      try {
        if (!terminal) {
          throw new Error("Terminal not available");
        }

        // Check for shell integration - wait briefly if not available
        if (!terminal.shellIntegration) {
          const shellIntegrationAvailable = await waitForShellIntegration(
            terminal
          );
          if (!shellIntegrationAvailable) {
            throw new Error("Shell integration not available in terminal");
          }
        }

        const { output } = await executeShellCommand(
          terminal,
          command,
          cwd,
          timeout,
          longLived
        );

        const result: CallToolResult = {
          content: [
            {
              type: "text",
              text: `Command: ${command}\n\nOutput:\n${output}`,
            },
          ],
        };
        return result;
      } catch (error) {
        console.error("[execute_shell_command] Error in tool:", error);
        throw error;
      }
    }
  );
}
