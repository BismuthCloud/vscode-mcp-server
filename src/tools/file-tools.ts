import * as vscode from "vscode";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Type for file listing results
export type FileListingResult = Array<{
  path: string;
  type: "file" | "directory";
}>;

// Type for the file listing callback function
export type FileListingCallback = (
  path: string,
  recursive: boolean,
  options?: FileListingOptions
) => Promise<FileListingResult>;

// File listing options
export interface FileListingOptions {
  ignoreGitignore?: boolean;
  maxDepth?: number;
  maxFiles?: number;
}

// Default maximum character count
const DEFAULT_MAX_CHARACTERS = 100000;

// File listing defaults and limits
const FILE_LISTING_DEFAULTS = {
  MAX_FILES: 200,
  MAX_DEPTH: 5,
  IGNORE_GITIGNORE: true,
};

// Hidden hard limits (not exposed to the model)
const HIDDEN_LIMITS = {
  ABSOLUTE_MAX_FILES: 500,
  ABSOLUTE_MAX_DEPTH: 10,
  TIMEOUT_MS: 5000,
  MAX_IMMEDIATE_CHILDREN: 1000,
};

// Directories to always exclude
const ALWAYS_EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  "coverage",
  ".nyc_output",
  ".tox",
  "eggs",
  ".eggs",
  "htmlcov",
  ".coverage",
  ".hypothesis",
  ".ruff_cache",
]);

/**
 * Reads gitignore patterns from .gitignore file
 * @param workspaceUri The workspace URI
 * @returns Array of gitignore patterns
 */
async function readGitignorePatterns(
  workspaceUri: vscode.Uri
): Promise<string[]> {
  try {
    const gitignoreUri = vscode.Uri.joinPath(workspaceUri, ".gitignore");
    const gitignoreContent = await vscode.workspace.fs.readFile(gitignoreUri);
    const content = new TextDecoder().decode(gitignoreContent);

    // Parse gitignore patterns (basic implementation)
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")); // Remove empty lines and comments
  } catch (error) {
    // No .gitignore file or error reading it
    return [];
  }
}

/**
 * Simple gitignore pattern matcher
 * @param path The path to check
 * @param patterns Array of gitignore patterns
 * @returns True if the path matches any pattern
 */
function matchesGitignorePattern(path: string, patterns: string[]): boolean {
  const normalizedPath = path.replace(/\\/g, "/");

  for (const pattern of patterns) {
    // Very basic pattern matching - just check if path contains the pattern
    // This handles common cases like "node_modules", ".env", etc.
    if (pattern.includes("/")) {
      // Pattern with directory separator
      if (normalizedPath.includes(pattern)) {
        return true;
      }
    } else {
      // Simple pattern - match against directory/file names
      const parts = normalizedPath.split("/");
      if (parts.some((part) => part === pattern || part.startsWith(pattern))) {
        return true;
      }
    }
  }

  return false;
}

// Cache for gitignore patterns
let gitignorePatternsCache: string[] | null = null;

/**
 * Checks if a path should be ignored based on gitignore
 * @param workspaceUri The workspace URI
 * @param relativePath The relative path to check
 * @returns True if the path should be ignored
 */
async function isGitIgnored(
  workspaceUri: vscode.Uri,
  relativePath: string
): Promise<boolean> {
  // Load gitignore patterns if not cached
  if (gitignorePatternsCache === null) {
    gitignorePatternsCache = await readGitignorePatterns(workspaceUri);
  }

  return matchesGitignorePattern(relativePath, gitignorePatternsCache);
}

/**
 * Lists files and directories in the VS Code workspace with safety limits
 * @param workspacePath The path within the workspace to list files from
 * @param recursive Whether to list files recursively
 * @param options Additional options for file listing
 * @returns Array of file and directory entries
 */
export async function listWorkspaceFiles(
  workspacePath: string,
  recursive: boolean = false,
  options: FileListingOptions = {}
): Promise<FileListingResult> {
  const {
    ignoreGitignore = FILE_LISTING_DEFAULTS.IGNORE_GITIGNORE,
    maxDepth = FILE_LISTING_DEFAULTS.MAX_DEPTH,
    maxFiles = FILE_LISTING_DEFAULTS.MAX_FILES,
  } = options;

  // Apply hidden limits
  const effectiveMaxDepth = Math.min(
    maxDepth,
    HIDDEN_LIMITS.ABSOLUTE_MAX_DEPTH
  );
  const effectiveMaxFiles = Math.min(
    maxFiles,
    HIDDEN_LIMITS.ABSOLUTE_MAX_FILES
  );

  console.log(
    `[listWorkspaceFiles] Starting with path: ${workspacePath}, recursive: ${recursive}, maxDepth: ${effectiveMaxDepth}, maxFiles: ${effectiveMaxFiles}, ignoreGitignore: ${ignoreGitignore}`
  );

  if (!vscode.workspace.workspaceFolders) {
    throw new Error("No workspace folder is open");
  }

  const workspaceFolder = vscode.workspace.workspaceFolders[0];
  const workspaceUri = workspaceFolder.uri;

  // Create URI for the target directory
  const targetUri = vscode.Uri.joinPath(workspaceUri, workspacePath);
  console.log(`[listWorkspaceFiles] Target URI: ${targetUri.fsPath}`);

  let fileCount = 0;
  let limitReached = false;
  const startTime = Date.now();

  async function processDirectory(
    dirUri: vscode.Uri,
    currentPath: string = "",
    currentDepth: number = 0
  ): Promise<FileListingResult> {
    // Check timeout
    if (Date.now() - startTime > HIDDEN_LIMITS.TIMEOUT_MS) {
      console.warn(
        `[listWorkspaceFiles] Timeout reached after ${HIDDEN_LIMITS.TIMEOUT_MS}ms`
      );
      limitReached = true;
      return [];
    }

    // Check depth limit
    if (recursive && currentDepth >= effectiveMaxDepth) {
      console.log(
        `[listWorkspaceFiles] Max depth ${effectiveMaxDepth} reached at ${currentPath}`
      );
      return [];
    }

    const entries = await vscode.workspace.fs.readDirectory(dirUri);

    // Check for directories with too many immediate children
    if (entries.length > HIDDEN_LIMITS.MAX_IMMEDIATE_CHILDREN) {
      console.warn(
        `[listWorkspaceFiles] Directory ${currentPath} has ${entries.length} entries, skipping`
      );
      return [
        {
          path: currentPath,
          type: "directory" as const,
        },
      ];
    }

    const result: FileListingResult = [];

    for (const [name, type] of entries) {
      // Check file count limit
      if (fileCount >= effectiveMaxFiles) {
        limitReached = true;
        break;
      }

      const entryPath = currentPath ? path.join(currentPath, name) : name;
      const itemType: "file" | "directory" =
        type & vscode.FileType.Directory ? "directory" : "file";

      // Check if directory should be excluded
      if (itemType === "directory" && ALWAYS_EXCLUDED_DIRS.has(name)) {
        console.log(
          `[listWorkspaceFiles] Skipping excluded directory: ${entryPath}`
        );
        continue;
      }

      // Check gitignore if enabled
      if (ignoreGitignore) {
        const isIgnored = await isGitIgnored(workspaceUri, entryPath);
        if (isIgnored) {
          console.log(
            `[listWorkspaceFiles] Skipping git-ignored path: ${entryPath}`
          );
          continue;
        }
      }

      result.push({ path: entryPath, type: itemType });
      fileCount++;

      if (recursive && itemType === "directory" && !limitReached) {
        const subDirUri = vscode.Uri.joinPath(dirUri, name);
        const subEntries = await processDirectory(
          subDirUri,
          entryPath,
          currentDepth + 1
        );
        result.push(...subEntries);
      }
    }

    return result;
  }

  try {
    const result = await processDirectory(targetUri);

    if (limitReached) {
      console.warn(
        `[listWorkspaceFiles] Listing stopped due to limits. Found ${fileCount} entries`
      );
      // Add a special entry to indicate truncation
      result.push({
        path: `[TRUNCATED: Reached limit of ${effectiveMaxFiles} files]`,
        type: "file" as const,
      });
    } else {
      console.log(`[listWorkspaceFiles] Found ${result.length} entries`);
    }

    return result;
  } catch (error) {
    console.error("[listWorkspaceFiles] Error:", error);
    throw error;
  }
}

/**
 * Reads a file from the VS Code workspace with character limit check
 * @param workspacePath The path within the workspace to the file
 * @param encoding Encoding to convert the file content to a string. Use 'base64' for base64-encoded string
 * @param maxCharacters Maximum character count (default: 100,000)
 * @param startLine The start line number (0-based, inclusive). Use -1 to read from the beginning.
 * @param endLine The end line number (0-based, inclusive). Use -1 to read to the end.
 * @returns File content as string (either text-encoded or base64)
 */
export async function readWorkspaceFile(
  workspacePath: string,
  encoding: string = "utf-8",
  maxCharacters: number = DEFAULT_MAX_CHARACTERS,
  startLine: number = -1,
  endLine: number = -1
): Promise<string> {
  console.log(
    `[readWorkspaceFile] Starting with path: ${workspacePath}, encoding: ${encoding}, maxCharacters: ${maxCharacters}, startLine: ${startLine}, endLine: ${endLine}`
  );

  if (!vscode.workspace.workspaceFolders) {
    throw new Error("No workspace folder is open");
  }

  const workspaceFolder = vscode.workspace.workspaceFolders[0];
  const workspaceUri = workspaceFolder.uri;

  // Create URI for the target file
  const fileUri = vscode.Uri.joinPath(workspaceUri, workspacePath);
  console.log(`[readWorkspaceFile] File URI: ${fileUri.fsPath}`);

  try {
    // Read the file content as Uint8Array
    const fileContent = await vscode.workspace.fs.readFile(fileUri);
    console.log(
      `[readWorkspaceFile] File read successfully, size: ${fileContent.byteLength} bytes`
    );

    if (encoding === "base64") {
      // Special case for base64 encoding
      if (fileContent.byteLength > maxCharacters) {
        throw new Error(
          `File content exceeds the maximum character limit (approx. ${fileContent.byteLength} bytes vs ${maxCharacters} allowed)`
        );
      }

      // For base64, we cannot extract lines meaningfully, so we ignore startLine and endLine
      if (startLine >= 0 || endLine >= 0) {
        console.warn(
          `[readWorkspaceFile] Line numbers specified for base64 encoding, ignoring`
        );
      }

      return Buffer.from(fileContent).toString("base64");
    } else {
      // Regular text encoding (utf-8, latin1, etc.)
      const textDecoder = new TextDecoder(encoding);
      const textContent = textDecoder.decode(fileContent);

      // Check if the character count exceeds the limit
      if (textContent.length > maxCharacters) {
        throw new Error(
          `File content exceeds the maximum character limit (${textContent.length} vs ${maxCharacters} allowed)`
        );
      }

      // If line numbers are specified and valid, extract just those lines
      if (startLine >= 0 || endLine >= 0) {
        // Split the content into lines
        const lines = textContent.split("\n");

        // Set effective start and end lines
        const effectiveStartLine = startLine >= 0 ? startLine : 0;
        const effectiveEndLine =
          endLine >= 0 ? Math.min(endLine, lines.length - 1) : lines.length - 1;

        // Validate line numbers
        if (effectiveStartLine >= lines.length) {
          throw new Error(
            `Start line ${effectiveStartLine + 1} is out of range (1-${
              lines.length
            })`
          );
        }

        // Make sure endLine is not less than startLine
        if (effectiveEndLine < effectiveStartLine) {
          throw new Error(
            `End line ${effectiveEndLine + 1} is less than start line ${
              effectiveStartLine + 1
            }`
          );
        }

        // Extract the requested lines and join them back together
        const partialContent = lines
          .slice(effectiveStartLine, effectiveEndLine + 1)
          .join("\n");
        console.log(
          `[readWorkspaceFile] Returning lines ${effectiveStartLine + 1}-${
            effectiveEndLine + 1
          }, length: ${partialContent.length} characters`
        );
        return partialContent;
      }

      return textContent;
    }
  } catch (error) {
    console.error("[readWorkspaceFile] Error:", error);
    throw error;
  }
}

/**
 * Registers MCP file-related tools with the server
 * @param server MCP server instance
 * @param fileListingCallback Callback function for file listing operations
 */
export function registerFileTools(
  server: McpServer,
  fileListingCallback: FileListingCallback
): void {
  // Add list_files tool
  server.tool(
    "list_files_code",
    `Explores directory structure in VS Code workspace with safety limits.

        WHEN TO USE: Understanding project structure, finding files before read/modify operations.
        
        LIMITS: 
        - Max ${FILE_LISTING_DEFAULTS.MAX_FILES} files returned (use specific paths to see more)
        - Max depth ${FILE_LISTING_DEFAULTS.MAX_DEPTH} for recursive listing
        - Git-ignored files excluded by default
        - Common build/dependency directories auto-excluded (node_modules, venv, etc.)
        
        Start with path='.' recursive=false to explore root, then dive into specific subdirectories.`,
    {
      path: z.string().describe("The path to list files from"),
      recursive: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to list files recursively"),
      ignore_gitignore: z
        .boolean()
        .optional()
        .default(FILE_LISTING_DEFAULTS.IGNORE_GITIGNORE)
        .describe("Whether to exclude git-ignored files"),
      max_depth: z
        .number()
        .optional()
        .default(FILE_LISTING_DEFAULTS.MAX_DEPTH)
        .describe("Maximum depth for recursive listing"),
      max_files: z
        .number()
        .optional()
        .default(FILE_LISTING_DEFAULTS.MAX_FILES)
        .describe("Maximum number of files to return"),
    },
    async ({
      path,
      recursive = false,
      ignore_gitignore = FILE_LISTING_DEFAULTS.IGNORE_GITIGNORE,
      max_depth = FILE_LISTING_DEFAULTS.MAX_DEPTH,
      max_files = FILE_LISTING_DEFAULTS.MAX_FILES,
    }): Promise<CallToolResult> => {
      console.log(
        `[list_files] Tool called with path=${path}, recursive=${recursive}, ignore_gitignore=${ignore_gitignore}, max_depth=${max_depth}, max_files=${max_files}`
      );

      if (!fileListingCallback) {
        console.error("[list_files] File listing callback not set");
        throw new Error("File listing callback not set");
      }

      try {
        console.log("[list_files] Calling file listing callback");
        const files = await fileListingCallback(path, recursive, {
          ignoreGitignore: ignore_gitignore,
          maxDepth: max_depth,
          maxFiles: max_files,
        });
        console.log(`[list_files] Callback returned ${files.length} items`);

        const result: CallToolResult = {
          content: [
            {
              type: "text",
              text: JSON.stringify(files, null, 2),
            },
          ],
        };
        console.log("[list_files] Successfully completed");
        return result;
      } catch (error) {
        console.error("[list_files] Error in tool:", error);
        throw error;
      }
    }
  );

  // Update read_file tool with line number parameters
  server.tool(
    "read_file_code",
    `Retrieves file contents with size limits and partial reading support.

        WHEN TO USE: Reading code, config files, analyzing implementations. Files >100k chars will fail.
        
        Encoding: Text encodings (utf-8, latin1, etc.) for text files, 'base64' for base64-encoded string.
        Line numbers: Use startLine/endLine (1-based) for large files to read specific sections only.
        
        If file too large: Use startLine/endLine to read relevant sections only.`,
    {
      path: z.string().describe("The path to the file to read"),
      encoding: z
        .string()
        .optional()
        .default("utf-8")
        .describe(
          'Encoding to convert the file content to a string. Use "base64" for base64-encoded string'
        ),
      maxCharacters: z
        .number()
        .optional()
        .default(DEFAULT_MAX_CHARACTERS)
        .describe("Maximum character count (default: 100,000)"),
      startLine: z
        .number()
        .optional()
        .default(-1)
        .describe(
          "The start line number (1-based, inclusive). Default: read from beginning, denoted by -1"
        ),
      endLine: z
        .number()
        .optional()
        .default(-1)
        .describe(
          "The end line number (1-based, inclusive). Default: read to end, denoted by -1"
        ),
    },
    async ({
      path,
      encoding = "utf-8",
      maxCharacters = DEFAULT_MAX_CHARACTERS,
      startLine = -1,
      endLine = -1,
    }): Promise<CallToolResult> => {
      console.log(
        `[read_file] Tool called with path=${path}, encoding=${encoding}, maxCharacters=${maxCharacters}, startLine=${startLine}, endLine=${endLine}`
      );

      // Convert 1-based input to 0-based for VS Code API
      const zeroBasedStartLine = startLine > 0 ? startLine - 1 : startLine;
      const zeroBasedEndLine = endLine > 0 ? endLine - 1 : endLine;

      try {
        console.log("[read_file] Reading file");
        const content = await readWorkspaceFile(
          path,
          encoding,
          maxCharacters,
          zeroBasedStartLine,
          zeroBasedEndLine
        );

        const result: CallToolResult = {
          content: [
            {
              type: "text",
              text: content,
            },
          ],
        };
        console.log(
          `[read_file] File read successfully, length: ${content.length} characters`
        );
        return result;
      } catch (error) {
        console.error("[read_file] Error in tool:", error);
        throw error;
      }
    }
  );
}
