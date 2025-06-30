import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { searchReplaceInFile } from "./search-replace";
import * as path from "path";

/**
 * Get all workspace diagnostics (Problems tab) after a short delay to allow LSP to update
 * @returns Formatted diagnostics string
 */
async function getAllDiagnosticsAfterDelay(): Promise<string> {
  // Wait a bit for LSP to update diagnostics
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Get all diagnostics from the workspace (what's shown in Problems tab)
  const allDiagnostics = vscode.languages.getDiagnostics();

  if (allDiagnostics.length === 0) {
    return "No problems found in workspace.";
  }

  // Count total issues
  let totalErrors = 0;
  let totalWarnings = 0;
  let totalOther = 0;

  for (const [uri, diagnostics] of allDiagnostics) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
        totalErrors++;
      } else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
        totalWarnings++;
      } else {
        totalOther++;
      }
    }
  }

  // Format diagnostics
  let output = `Problems tab summary: ${totalErrors} error(s), ${totalWarnings} warning(s)`;
  if (totalOther > 0) {
    output += `, ${totalOther} other(s)`;
  }
  output += "\n\n";

  // Show first few problems for context
  let problemCount = 0;
  const maxProblemsToShow = 10;

  for (const [uri, diagnostics] of allDiagnostics) {
    if (problemCount >= maxProblemsToShow) {
      output += `\n... and ${
        totalErrors + totalWarnings + totalOther - problemCount
      } more problem(s)`;
      break;
    }

    const relativePath = vscode.workspace.asRelativePath(uri);

    for (const diagnostic of diagnostics) {
      if (problemCount >= maxProblemsToShow) break;

      const severity =
        diagnostic.severity === vscode.DiagnosticSeverity.Error
          ? "Error"
          : diagnostic.severity === vscode.DiagnosticSeverity.Warning
          ? "Warning"
          : diagnostic.severity === vscode.DiagnosticSeverity.Information
          ? "Info"
          : "Hint";

      output += `${severity}: ${relativePath}:${
        diagnostic.range.start.line + 1
      }:${diagnostic.range.start.character + 1}\n`;
      output += `  ${diagnostic.message}`;

      if (diagnostic.source) {
        output += ` [${diagnostic.source}]`;
      }

      output += "\n\n";
      problemCount++;
    }
  }

  return output.trim();
}

/**
 * Writes content to a file in the VS Code workspace using WorkspaceEdit
 * @param workspacePath The path within the workspace to the file
 * @param content The content to write to the file
 * @param overwrite Whether to overwrite if the file exists
 * @param ignoreIfExists Whether to ignore if the file exists
 * @returns Promise that resolves when the edit operation completes
 */
export async function writeToWorkspaceFile(
  workspacePath: string,
  content: string,
  overwrite: boolean = false,
  ignoreIfExists: boolean = false
): Promise<void> {
  console.log(
    `[writeToWorkspaceFile] Starting with path: ${workspacePath}, overwrite: ${overwrite}, ignoreIfExists: ${ignoreIfExists}`
  );

  if (!vscode.workspace.workspaceFolders) {
    throw new Error("No workspace folder is open");
  }

  const workspaceFolder = vscode.workspace.workspaceFolders[0];
  const workspaceUri = workspaceFolder.uri;

  // Create URI for the target file
  const fileUri = vscode.Uri.joinPath(workspaceUri, workspacePath);
  console.log(`[createWorkspaceFile] File URI: ${fileUri.fsPath}`);

  try {
    // Create a WorkspaceEdit
    const workspaceEdit = new vscode.WorkspaceEdit();

    // Convert content to Uint8Array
    const contentBuffer = new TextEncoder().encode(content);

    // Add createFile operation to the edit
    workspaceEdit.createFile(fileUri, {
      contents: contentBuffer,
      overwrite: overwrite,
      ignoreIfExists: ignoreIfExists,
    });

    // Apply the edit
    const success = await vscode.workspace.applyEdit(workspaceEdit);

    if (success) {
      console.log(
        `[writeToWorkspaceFile] File created successfully: ${fileUri.fsPath}`
      );

      // Open the document to trigger linting
      const document = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(document);
      console.log(`[writeToWorkspaceFile] File opened in editor`);
    } else {
      throw new Error(`Failed to create file: ${fileUri.fsPath}`);
    }
  } catch (error) {
    console.error("[writeToWorkspaceFile] Error:", error);
    throw error;
  }
}

/**
 * Replaces specific lines in a file in the VS Code workspace
 * @param workspacePath The path within the workspace to the file
 * @param startLine The start line number (0-based, inclusive)
 * @param endLine The end line number (0-based, inclusive)
 * @param content The new content to replace the lines with
 * @param originalCode The original code for validation
 * @returns Promise that resolves when the edit operation completes
 */
export async function replaceWorkspaceFileLines(
  workspacePath: string,
  startLine: number,
  endLine: number,
  content: string,
  originalCode: string
): Promise<void> {
  console.log(
    `[replaceWorkspaceFileLines] Starting with path: ${workspacePath}, lines: ${startLine}-${endLine}`
  );

  if (!vscode.workspace.workspaceFolders) {
    throw new Error("No workspace folder is open");
  }

  const workspaceFolder = vscode.workspace.workspaceFolders[0];
  const workspaceUri = workspaceFolder.uri;

  // Create URI for the target file
  const fileUri = vscode.Uri.joinPath(workspaceUri, workspacePath);
  console.log(`[replaceWorkspaceFileLines] File URI: ${fileUri.fsPath}`);

  try {
    // Open the document (or get it if already open)
    const document = await vscode.workspace.openTextDocument(fileUri);

    // Validate line numbers
    if (startLine < 0 || startLine >= document.lineCount) {
      throw new Error(
        `Start line ${startLine + 1} is out of range (1-${document.lineCount})`
      );
    }
    if (endLine < startLine || endLine >= document.lineCount) {
      throw new Error(
        `End line ${endLine + 1} is out of range (${startLine + 1}-${
          document.lineCount
        })`
      );
    }

    // Get the current content of the lines
    const currentLines = [];
    for (let i = startLine; i <= endLine; i++) {
      currentLines.push(document.lineAt(i).text);
    }
    const currentContent = currentLines.join("\n");

    // Compare with the provided original code
    if (currentContent !== originalCode) {
      throw new Error(
        `Original code validation failed. The current content does not match the provided original code.`
      );
    }

    // Create a range for the lines to replace
    const startPos = new vscode.Position(startLine, 0);
    const endPos = new vscode.Position(
      endLine,
      document.lineAt(endLine).text.length
    );
    const range = new vscode.Range(startPos, endPos);

    // Get the active text editor or show the document
    let editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== fileUri.toString()) {
      editor = await vscode.window.showTextDocument(document);
    }

    // Apply the edit
    const success = await editor.edit((editBuilder) => {
      editBuilder.replace(range, content);
    });

    if (success) {
      console.log(`[replaceWorkspaceFileLines] Lines replaced successfully`);

      // Save the document to persist changes
      await document.save();
      console.log(`[replaceWorkspaceFileLines] Document saved`);
    } else {
      throw new Error(`Failed to replace lines in file: ${fileUri.fsPath}`);
    }
  } catch (error) {
    console.error("[replaceWorkspaceFileLines] Error:", error);
    throw error;
  }
}

/**
 * Registers MCP edit-related tools with the server
 * @param server MCP server instance
 */
export function registerEditTools(server: McpServer): void {
  // Add write_to_file tool
  server.tool(
    "write_to_file",
    `Writes content to a file (creates new or overwrites existing).

        WHEN TO USE: ONLY for creating new files or when search_replace has failed.
        ALWAYS TRY search_replace FIRST for: ANY edits to existing files, even large changes.

        File handling: Use overwrite=true to replace existing files, ignoreIfExists=true to skip if file exists.
        Always check with list_files_code first unless you specifically want to overwrite.
        
        DIAGNOSTICS: This tool returns workspace diagnostics after writing. Pay attention to:
        - ERRORS: Must be fixed if they prevent the app from functioning
        - WARNINGS: Should be addressed if they impact the user's task
        - Review the diagnostics and fix critical issues before proceeding`,
    {
      path: z.string().describe("The path to the file to write"),
      content: z.string().describe("The content to write to the file"),
      overwrite: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to overwrite if the file exists"),
      ignoreIfExists: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to ignore if the file exists"),
    },
    async ({
      path,
      content,
      overwrite = false,
      ignoreIfExists = false,
    }): Promise<CallToolResult> => {
      console.log(
        `[write_to_file] Tool called with path=${path}, overwrite=${overwrite}, ignoreIfExists=${ignoreIfExists}`
      );

      try {
        console.log("[write_to_file] Writing file");
        await writeToWorkspaceFile(path, content, overwrite, ignoreIfExists);

        // Get all workspace diagnostics (Problems tab)
        const diagnostics = await getAllDiagnosticsAfterDelay();

        const result: CallToolResult = {
          content: [
            {
              type: "text",
              text: `File ${path} written successfully\n\n===== WORKSPACE DIAGNOSTICS (Problems Tab) =====\n${diagnostics}`,
            },
          ],
        };
        console.log("[write_to_file] Successfully completed");
        return result;
      } catch (error) {
        console.error("[write_to_file] Error in tool:", error);
        throw error;
      }
    }
  );

  // Add search_replace tool
  server.tool(
    "search_replace",
    `Performs search and replace operations on existing files with visual diff feedback.

        WHEN TO USE: ALWAYS your FIRST CHOICE for editing existing files, regardless of change size.
        This is the PREFERRED method for ALL file modifications, from small edits to large rewrites.

        Features:
        - Exact match search (tries first)
        - Whitespace-tolerant match (ignores leading/trailing spaces)
        - Block anchor match (for 3+ line blocks using first/last lines)
        - Shows diff view for visual feedback (changes applied automatically)
        - Empty search replaces entire file content

        DIAGNOSTICS: This tool returns workspace diagnostics after editing. IMPORTANT:
        - Review ALL errors and warnings in the diagnostics output
        - Fix ERRORS that prevent functionality (syntax errors, type errors, etc.)
        - Address WARNINGS that impact the user's task or code quality
        - The diagnostics show ALL workspace issues, not just the edited file

        Only use write_to_file if this tool fails or for creating new files.`,
    {
      path: z.string().describe("The path to the file to modify"),
      search: z
        .string()
        .describe("The content to search for (empty to replace entire file)"),
      replace: z.string().describe("The content to replace with"),
    },
    async ({ path, search, replace }): Promise<CallToolResult> => {
      console.log(`[search_replace] Tool called with path=${path}`);

      try {
        console.log("[search_replace] Performing search and replace");
        await searchReplaceInFile(path, search, replace, true);

        // Get all workspace diagnostics (Problems tab)
        const diagnostics = await getAllDiagnosticsAfterDelay();

        const result: CallToolResult = {
          content: [
            {
              type: "text",
              text: `Search and replace completed successfully in ${path}\n\n===== WORKSPACE DIAGNOSTICS (Problems Tab) =====\n${diagnostics}`,
            },
          ],
        };
        console.log("[search_replace] Successfully completed");
        return result;
      } catch (error) {
        console.error("[search_replace] Error in tool:", error);
        throw error;
      }
    }
  );
}
