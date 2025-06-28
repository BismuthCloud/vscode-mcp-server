import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";

/**
 * Attempts to find the search content in the original content using exact match
 */
function findExactMatch(
  originalContent: string,
  searchContent: string,
  startIndex: number = 0
): [number, number] | null {
  const index = originalContent.indexOf(searchContent, startIndex);
  if (index !== -1) {
    return [index, index + searchContent.length];
  }
  return null;
}

/**
 * Attempts to find the search content using line-by-line comparison with trimmed whitespace
 */
function findTrimmedMatch(
  originalContent: string,
  searchContent: string,
  startIndex: number = 0
): [number, number] | null {
  const originalLines = originalContent.split("\n");
  const searchLines = searchContent.split("\n");

  // Remove trailing empty line if exists
  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  // Find the line number where startIndex falls
  let startLineNum = 0;
  let currentIndex = 0;
  while (currentIndex < startIndex && startLineNum < originalLines.length) {
    currentIndex += originalLines[startLineNum].length + 1; // +1 for \n
    startLineNum++;
  }

  // Try to match from each possible position
  for (
    let i = startLineNum;
    i <= originalLines.length - searchLines.length;
    i++
  ) {
    let matches = true;

    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }

    if (matches) {
      // Calculate exact character positions
      let matchStartIndex = 0;
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1;
      }

      let matchEndIndex = matchStartIndex;
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length + 1;
      }

      return [matchStartIndex, matchEndIndex];
    }
  }

  return null;
}

/**
 * Attempts to find the search content using first and last line as anchors
 * Only works for blocks of 3+ lines
 */
function findAnchorMatch(
  originalContent: string,
  searchContent: string,
  startIndex: number = 0
): [number, number] | null {
  const originalLines = originalContent.split("\n");
  const searchLines = searchContent.split("\n");

  // Only use this for blocks of 3+ lines
  if (searchLines.length < 3) {
    return null;
  }

  // Remove trailing empty line if exists
  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  const firstLineSearch = searchLines[0].trim();
  const lastLineSearch = searchLines[searchLines.length - 1].trim();
  const blockSize = searchLines.length;

  // Find the line number where startIndex falls
  let startLineNum = 0;
  let currentIndex = 0;
  while (currentIndex < startIndex && startLineNum < originalLines.length) {
    currentIndex += originalLines[startLineNum].length + 1;
    startLineNum++;
  }

  // Look for matching anchors
  for (let i = startLineNum; i <= originalLines.length - blockSize; i++) {
    if (
      originalLines[i].trim() === firstLineSearch &&
      originalLines[i + blockSize - 1].trim() === lastLineSearch
    ) {
      // Calculate exact character positions
      let matchStartIndex = 0;
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1;
      }

      let matchEndIndex = matchStartIndex;
      for (let k = 0; k < blockSize; k++) {
        matchEndIndex += originalLines[i + k].length + 1;
      }

      return [matchStartIndex, matchEndIndex];
    }
  }

  return null;
}

/**
 * Applies a search and replace operation to file content
 */
export function applySearchReplace(
  originalContent: string,
  searchContent: string,
  replaceContent: string
): string {
  // Handle empty search - replace entire file
  if (!searchContent || searchContent.trim() === "") {
    return replaceContent;
  }

  // Try exact match first
  let match = findExactMatch(originalContent, searchContent);

  // Try trimmed match if exact fails
  if (!match) {
    match = findTrimmedMatch(originalContent, searchContent);
  }

  // Try anchor match for larger blocks
  if (!match) {
    match = findAnchorMatch(originalContent, searchContent);
  }

  // If no match found, throw error
  if (!match) {
    throw new Error(
      `Could not find the specified content in the file. The search content does not match any part of the file.`
    );
  }

  const [startIndex, endIndex] = match;

  // Build the result
  return (
    originalContent.slice(0, startIndex) +
    replaceContent +
    originalContent.slice(endIndex)
  );
}

/**
 * Shows a diff editor for visual feedback (changes are applied automatically)
 */
export async function showDiff(
  originalUri: vscode.Uri,
  originalContent: string,
  modifiedContent: string,
  title: string
): Promise<void> {
  // Create a temporary file for the modified content
  const tempDir = os.tmpdir();
  const tempFileName = `vscode-mcp-${Date.now()}-${path.basename(
    originalUri.fsPath
  )}`;
  const tempFilePath = path.join(tempDir, tempFileName);

  try {
    // Write modified content to temp file
    await fs.writeFile(tempFilePath, modifiedContent, "utf8");
    const tempUri = vscode.Uri.file(tempFilePath);

    // Open diff editor for visual feedback
    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      tempUri,
      title,
      {
        preview: true,
        preserveFocus: false,
      }
    );

    // Clean up temp file after a short delay to allow diff view to load
    setTimeout(async () => {
      try {
        await fs.unlink(tempFilePath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }, 1000);
  } catch (error) {
    // Clean up on error
    try {
      await fs.unlink(tempFilePath);
    } catch (e) {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Performs a search and replace operation on a file in the workspace
 */
export async function searchReplaceInFile(
  workspacePath: string,
  searchContent: string,
  replaceContent: string,
  showDiffView: boolean = true
): Promise<void> {
  if (!vscode.workspace.workspaceFolders) {
    throw new Error("No workspace folder is open");
  }

  const workspaceFolder = vscode.workspace.workspaceFolders[0];
  const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, workspacePath);

  // Read the current file content
  const fileContent = await vscode.workspace.fs.readFile(fileUri);
  const originalContent = new TextDecoder().decode(fileContent);

  // Apply the search and replace
  const modifiedContent = applySearchReplace(
    originalContent,
    searchContent,
    replaceContent
  );

  // Apply the changes immediately
  const modifiedBuffer = new TextEncoder().encode(modifiedContent);
  await vscode.workspace.fs.writeFile(fileUri, modifiedBuffer);

  // Open the file to show the changes
  const document = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(document);

  // If showDiffView is enabled, show diff editor for visual feedback (after applying changes)
  if (showDiffView) {
    await showDiff(
      fileUri,
      originalContent,
      modifiedContent,
      `Search & Replace: ${path.basename(workspacePath)}`
    );
  }
}
