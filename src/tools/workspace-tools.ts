import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as os from "os";

interface WorkspaceInfo {
  workspaceRoot: string | null;
  workspaceName: string | null;
  workspaceFolders: Array<{
    name: string;
    path: string;
  }>;
  openEditors: string[]; // Just file paths, not content
  platform: NodeJS.Platform;
  homeDir: string;
}

/**
 * Get essential workspace metadata for LLM context
 * @returns WorkspaceInfo object with workspace metadata (paths only, no file contents)
 */
function getWorkspaceInfo(): WorkspaceInfo {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];

  console.log("Getting workspace info.");

  // Get open editor file paths (relative paths for readability)
  const openEditors = vscode.workspace.textDocuments
    .filter((doc) => doc.uri.scheme === "file")
    .map((doc) => vscode.workspace.asRelativePath(doc.uri));

  const info: WorkspaceInfo = {
    workspaceRoot:
      workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : null,
    workspaceName:
      workspaceFolders.length > 0 ? workspaceFolders[0].name : null,
    workspaceFolders: workspaceFolders.map((folder) => ({
      name: folder.name,
      path: folder.uri.fsPath,
    })),
    openEditors: openEditors,
    platform: process.platform,
    homeDir: os.homedir(),
  };

  console.log("Returning workspace info.");

  return info;
}

/**
 * Registers MCP workspace-related tools with the server
 * @param server MCP server instance
 */
export function registerWorkspaceTools(server: McpServer): void {
  // Add get_workspace_info tool - designed for programmatic use
  server.tool(
    "get_workspace_info",
    `[INTERNAL TOOL - NOT FOR LLM USE]
    
    Returns workspace metadata (paths only, no file contents):
    - Workspace root path and name
    - All workspace folders (names and paths)
    - Open editors (file paths only)
    - Platform and home directory
    
    This tool is designed to be called programmatically by the MCP client,
    not by the LLM. It provides essential context about the VS Code environment.`,
    {
      // No parameters needed
    },
    async (): Promise<CallToolResult> => {
      console.log("[get_workspace_info] Tool called");

      try {
        const workspaceInfo = getWorkspaceInfo();

        const result: CallToolResult = {
          content: [
            {
              type: "text",
              text: JSON.stringify(workspaceInfo, null, 2),
            },
          ],
        };

        console.log("[get_workspace_info] Successfully completed");
        return result;
      } catch (error) {
        console.error("[get_workspace_info] Error in tool:", error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error getting workspace info: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
