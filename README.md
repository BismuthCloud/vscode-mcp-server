# BismuthVS

BismuthVS - Enables Bismuth to drive VSCode

## Credits

This extension is based on [vscode-mcp-server](https://github.com/juehang/vscode-mcp-server) by Juehang Qin. Special thanks to the original author for creating an excellent foundation that made this extension possible.

## Overview

BismuthVS is a Visual Studio Code extension that allows Bismuth to interact with and control VS Code through a custom WebSocket transport. This extension exposes VS Code's filesystem, editing capabilities, and other features to Bismuth.

## Features

The BismuthVS extension provides Bismuth with the ability to:

- **List files and directories** in your VS Code workspace
- **Read file contents** with encoding support and size limits
- **Search for symbols** across your workspace
- **Get symbol definitions** and hover information by line and symbol name
- **Create new files** using VS Code's WorkspaceEdit API
- **Make line replacements** in files
- **Check for diagnostics** (errors and warnings) in your workspace
- **Execute shell commands** in the integrated terminal with shell integration
- **Toggle the server** on and off via a status bar item

## Installation

1. Install the extension from the VS Code Marketplace (when available)
2. Or clone this repository and run `npm install` and `npm run compile` to build it

## Configuration

### Extension Settings

* `vscode-mcp-server.apiKey`: The API key for authenticating with Bismuth (required)
* `vscode-mcp-server.defaultEnabled`: Whether the server should be enabled by default on VS Code startup
* `vscode-mcp-server.enabledTools`: Configure which tool categories are enabled (file, edit, shell, diagnostics, symbol)

### Starting the Server

1. Set your API key in VS Code settings
2. Click the status bar item (bottom right) to toggle the server on/off
3. The status bar will show:
   - "MCP Server: Off" - Server is disabled
   - "MCP Server: Connecting..." - Server is starting
   - "MCP Server: Connected" - Server is active and connected to Bismuth

## Supported Tools

### File Tools
- **list_files_code**: Lists files and directories in your workspace with safety limits
  - Parameters:
    - `path`: The path to list files from
    - `recursive` (optional): Whether to list files recursively (default: false)
    - `ignore_gitignore` (optional): Whether to exclude git-ignored files (default: true)
    - `max_depth` (optional): Maximum depth for recursive listing (default: 5)
    - `max_files` (optional): Maximum number of files to return (default: 200)
  - Safety features:
    - Automatically excludes common build/dependency directories (node_modules, venv, etc.)
    - Respects .gitignore patterns by default
    - Limits prevent runaway recursion

- **read_file_code**: Reads file contents
  - Parameters:
    - `path`: The path to the file to read
    - `encoding` (optional): File encoding (default: utf-8)
    - `maxCharacters` (optional): Maximum character count (default: 100,000)

### Edit Tools
- **write_to_file**: Writes content to a file (creates new or overwrites existing)
  - Parameters:
    - `path`: The path to the file to write
    - `content`: The content to write to the file
    - `overwrite` (optional): Whether to overwrite if the file exists (default: false)
    - `ignoreIfExists` (optional): Whether to ignore if the file exists (default: false)

- **search_replace**: Performs search and replace operations with visual diff feedback
  - Parameters:
    - `path`: The path to the file to modify
    - `search`: The content to search for (empty to replace entire file)
    - `replace`: The content to replace with
  - Features:
    - Exact match search (tries first)
    - Whitespace-tolerant match (ignores leading/trailing spaces)
    - Block anchor match (for 3+ line blocks using first/last lines)
    - Shows diff view for visual feedback (changes applied automatically)

### Diagnostics Tools
- **get_diagnostics_code**: Checks for warnings and errors in your workspace
  - Parameters:
    - `path` (optional): File path to check (if not provided, checks the entire workspace)
    - `severities` (optional): Array of severity levels to include (0=Error, 1=Warning, 2=Information, 3=Hint). Default: [0, 1]
    - `format` (optional): Output format ('text' or 'json'). Default: 'text'
    - `includeSource` (optional): Whether to include the diagnostic source. Default: true

### Symbol Tools
- **search_symbols_code**: Searches for symbols across the workspace
  - Parameters:
    - `query`: The search query for symbol names
    - `maxResults` (optional): Maximum number of results to return (default: 10)

- **get_symbol_definition_code**: Gets definition information for a symbol in a file
  - Parameters:
    - `path`: The path to the file containing the symbol
    - `line`: The line number of the symbol
    - `symbol`: The symbol name to look for on the specified line

- **get_document_symbols_code**: Gets an outline of all symbols in a file
  - Parameters:
    - `path`: The path to the file to analyze
    - `maxDepth` (optional): Maximum nesting depth to display

### Shell Tools
- **execute_shell_command_code**: Executes a shell command in the VS Code integrated terminal
  - Parameters:
    - `command`: The shell command to execute
    - `cwd` (optional): Optional working directory for the command (default: '.')

## Security Considerations

This extension can execute shell commands, which means there is a potential security risk. Use with caution and ensure that:
- Your API key is kept secret
- The server port (default: 3000) is not exposed to untrusted networks
- You trust the Bismuth instance connecting to your VS Code

## Limitations

- Currently only supports one workspace at a time
- Runs locally only to avoid network exposure
- Requires manual server activation via the status bar

## Contributing

Contributions are welcome! Feel free to submit issues or pull requests.

## License

[MIT](LICENSE) - See LICENSE file for details.

Original work Copyright (c) Juehang Qin
Modified work Copyright (c) Bismuth
