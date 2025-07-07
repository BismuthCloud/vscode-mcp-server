import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

interface SearchMatch {
  line: number;
  column: number;
  text: string;
  preview: {
    before: string[];
    match: string;
    after: string[];
  };
}

interface SearchResult {
  path: string;
  matches: SearchMatch[];
}

interface SearchResponse {
  totalMatches: number;
  results: SearchResult[];
}

interface RipgrepMatch {
  type: string;
  data: {
    path?: { text: string };
    lines?: { text: string };
    line_number?: number;
    absolute_offset?: number;
    submatches?: Array<{
      match: { text: string };
      start: number;
      end: number;
    }>;
  };
}

/**
 * Find the ripgrep binary
 */
async function findRipgrepBinary(): Promise<string> {
  // Try to use @vscode/ripgrep package
  try {
    const rgPath = require("@vscode/ripgrep").rgPath;
    if (fs.existsSync(rgPath)) {
      logger.info(`[search_code] Found ripgrep at: ${rgPath}`);
      return rgPath;
    }
  } catch (e) {
    logger.warn(`[search_code] Could not load @vscode/ripgrep: ${e}`);
  }

  // Try common locations for VS Code's bundled ripgrep
  const possiblePaths = [
    // macOS
    "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg",
    "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg",
    // Linux
    "/usr/share/code/resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg",
    "/usr/share/code-insiders/resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg",
    // Windows
    "C:\\Program Files\\Microsoft VS Code\\resources\\app\\node_modules.asar.unpacked\\@vscode\\ripgrep\\bin\\rg.exe",
    "C:\\Program Files\\Microsoft VS Code Insiders\\resources\\app\\node_modules.asar.unpacked\\@vscode\\ripgrep\\bin\\rg.exe",
  ];

  for (const path of possiblePaths) {
    if (fs.existsSync(path)) {
      logger.info(`[search_code] Found VS Code's ripgrep at: ${path}`);
      return path;
    }
  }

  // Last resort: try system ripgrep
  return "rg";
}

/**
 * Performs a text search using ripgrep
 */
async function searchWithRipgrep(
  query: string,
  options: {
    include?: string;
    exclude?: string;
    isRegex?: boolean;
    isCaseSensitive?: boolean;
    isWordMatch?: boolean;
    maxResults?: number;
  }
): Promise<SearchResponse> {
  if (!vscode.workspace.workspaceFolders) {
    throw new Error("No workspace folder is open");
  }

  const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const rgPath = await findRipgrepBinary();

  // Build ripgrep arguments
  const args: string[] = [
    "--json", // JSON output for structured results
    "--max-count",
    String(options.maxResults || 100),
    "--context",
    "2", // 2 lines of context before and after
  ];

  // Add search modifiers
  if (!options.isCaseSensitive) {
    args.push("--ignore-case");
  }
  if (options.isWordMatch) {
    args.push("--word-regexp");
  }
  if (!options.isRegex) {
    args.push("--fixed-strings");
  }

  // Add include patterns
  if (options.include) {
    const includes = options.include.split(",").map((p) => p.trim());
    for (const pattern of includes) {
      args.push("--glob", pattern);
    }
  }

  // Add exclude patterns
  if (options.exclude) {
    const excludes = options.exclude.split(",").map((p) => p.trim());
    for (const pattern of excludes) {
      args.push("--glob", `!${pattern}`);
    }
  }

  // Add the search query
  args.push(query);

  // Add the search path
  args.push(workspaceRoot);

  logger.info(`[search_code] Running ripgrep with args: ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const results: SearchResult[] = [];
    let totalMatches = 0;
    let currentFile: SearchResult | null = null;
    let contextBefore: string[] = [];
    let contextAfter: string[] = [];
    let lastMatchLine = -1;

    const rg = spawn(rgPath, args, {
      cwd: workspaceRoot,
      env: { ...process.env, LANG: "en_US.UTF-8" },
    });

    let buffer = "";

    rg.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const json: RipgrepMatch = JSON.parse(line);

          if (json.type === "begin" && json.data.path) {
            // New file
            if (currentFile && currentFile.matches.length > 0) {
              results.push(currentFile);
            }
            const relativePath = path.relative(
              workspaceRoot,
              json.data.path.text
            );
            currentFile = {
              path: relativePath,
              matches: [],
            };
            contextBefore = [];
            contextAfter = [];
            lastMatchLine = -1;
          } else if (json.type === "match" && currentFile) {
            // Match found
            const lineNumber = json.data.line_number || 0;
            const lineText = json.data.lines?.text || "";
            const submatches = json.data.submatches || [];

            // Get column from first submatch
            const column = submatches.length > 0 ? submatches[0].start + 1 : 1;

            totalMatches++;

            // Store the match with its context
            currentFile.matches.push({
              line: lineNumber,
              column: column,
              text: lineText.trimEnd(),
              preview: {
                before: [...contextBefore],
                match: lineText.trimEnd(),
                after: [], // Will be filled by context lines
              },
            });

            lastMatchLine = lineNumber;
            contextBefore = []; // Reset context for next match
          } else if (
            json.type === "context" &&
            currentFile &&
            currentFile.matches.length > 0
          ) {
            // Context line
            const lineNumber = json.data.line_number || 0;
            const lineText = json.data.lines?.text || "";

            if (lineNumber < lastMatchLine) {
              // This is before context for the next match
              contextBefore.push(lineText.trimEnd());
              if (contextBefore.length > 2) {
                contextBefore.shift(); // Keep only last 2 lines
              }
            } else {
              // This is after context for the last match
              const lastMatch =
                currentFile.matches[currentFile.matches.length - 1];
              if (lastMatch.preview.after.length < 2) {
                lastMatch.preview.after.push(lineText.trimEnd());
              }
            }
          }
        } catch (e) {
          logger.error(`[search_code] Error parsing ripgrep output: ${e}`);
        }
      }
    });

    rg.stderr.on("data", (data) => {
      logger.error(`[search_code] Ripgrep stderr: ${data}`);
    });

    rg.on("close", (code) => {
      // Process any remaining data
      if (buffer.trim()) {
        try {
          const json: RipgrepMatch = JSON.parse(buffer);
          // Process the last line if needed
        } catch (e) {
          // Ignore parse errors on close
        }
      }

      // Add the last file if it has matches
      if (currentFile && currentFile.matches.length > 0) {
        results.push(currentFile);
      }

      if (code === 0 || code === 1) {
        // code 0 = matches found, code 1 = no matches found (both are success)
        resolve({
          totalMatches,
          results,
        });
      } else {
        reject(new Error(`Ripgrep exited with code ${code}`));
      }
    });

    rg.on("error", (error) => {
      reject(new Error(`Failed to spawn ripgrep: ${error.message}`));
    });
  });
}

/**
 * Registers MCP search-related tools with the server
 */
export function registerSearchTools(server: McpServer): void {
  server.tool(
    "search_code",
    `Searches for text or patterns across files in the VS Code workspace using ripgrep.

    Features:
    - Blazing fast search powered by ripgrep
    - Supports literal text and regex patterns
    - File include/exclude patterns with glob syntax
    - Case sensitivity and whole word options
    - Returns matches with 2 lines of context before and after
    - Automatically respects .gitignore and binary files

    Examples:
    - Simple text: search for "logger" across all files
    - With includes: search for "import" in "*.ts,*.js" files
    - With excludes: search excluding "node_modules/**,dist/**"
    - Regex search: search for "function\\s+\\w+\\s*\\(" with isRegex=true`,
    {
      query: z.string().describe("The search text or regex pattern to find"),
      include: z
        .string()
        .optional()
        .describe(
          'File glob patterns to include, comma-separated (e.g., "*.ts,*.js")'
        ),
      exclude: z
        .string()
        .optional()
        .describe(
          'File glob patterns to exclude, comma-separated (e.g., "node_modules/**,dist/**")'
        ),
      isRegex: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether the query is a regular expression"),
      isCaseSensitive: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether the search is case sensitive"),
      isWordMatch: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to match whole words only"),
      maxResults: z
        .number()
        .optional()
        .default(100)
        .describe("Maximum number of results to return"),
    },
    async ({
      query,
      include,
      exclude,
      isRegex = false,
      isCaseSensitive = false,
      isWordMatch = false,
      maxResults = 100,
    }): Promise<CallToolResult> => {
      logger.info(
        `[search_code] Searching for: "${query}" with options: ${JSON.stringify(
          {
            include,
            exclude,
            isRegex,
            isCaseSensitive,
            isWordMatch,
            maxResults,
          }
        )}`
      );

      try {
        const searchResults = await searchWithRipgrep(query, {
          include,
          exclude,
          isRegex,
          isCaseSensitive,
          isWordMatch,
          maxResults,
        });

        const result: CallToolResult = {
          content: [
            {
              type: "text",
              text: JSON.stringify(searchResults, null, 2),
            },
          ],
        };

        logger.info(
          `[search_code] Search completed: ${searchResults.totalMatches} matches in ${searchResults.results.length} files`
        );
        return result;
      } catch (error) {
        logger.error(`[search_code] Error: ${error}`);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error performing search: ${errorMessage}`,
            },
          ],
          error: true,
        };
      }
    }
  );
}
