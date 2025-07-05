import * as vscode from "vscode";
import { MCPServer, ToolConfiguration } from "./server";
import { listWorkspaceFiles } from "./tools/file-tools";
import { logger } from "./utils/logger";

// Re-export for testing purposes
export { MCPServer };

let mcpServer: MCPServer | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let sharedTerminal: vscode.Terminal | undefined;
// Server state - disabled by default
let serverEnabled: boolean = false;

// Terminal name constant
const TERMINAL_NAME = "BismuthVS Shell Commands";

/**
 * Gets the tool configuration from VS Code settings
 * @returns ToolConfiguration object with all tool enablement settings
 */
function getToolConfiguration(): ToolConfiguration {
  const config = vscode.workspace.getConfiguration("vscode-mcp-server");
  const enabledTools = config.get<any>("enabledTools") || {};

  return {
    file: enabledTools.file ?? true,
    edit: enabledTools.edit ?? true,
    shell: enabledTools.shell ?? true,
    diagnostics: enabledTools.diagnostics ?? true,
    symbol: enabledTools.symbol ?? true,
    search: enabledTools.search ?? true,
  };
}

/**
 * Gets the client websocket base URL from VS Code settings
 * @returns The client websocket base URL
 */
function getClientWebsocketBaseUrl(): string {
  const config = vscode.workspace.getConfiguration("vscode-mcp-server");
  return (
    config.get<string>("clientWebsocketBaseUrl") ||
    "ws://localhost:8765/superlinear/code-editor-mcp"
  );
}

/**
 * Gets or creates the shared terminal for the extension
 * @param context The extension context
 * @returns The shared terminal instance
 */
export function getExtensionTerminal(
  context: vscode.ExtensionContext
): vscode.Terminal {
  // Check if a terminal with our name already exists
  const existingTerminal = vscode.window.terminals.find(
    (t) => t.name === TERMINAL_NAME
  );

  if (existingTerminal && existingTerminal.exitStatus === undefined) {
    // Reuse the existing terminal if it's still open
    logger.info(
      "[getExtensionTerminal] Reusing existing terminal for shell commands"
    );
    return existingTerminal;
  }

  // Create a new terminal if it doesn't exist or if it has exited
  sharedTerminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    iconPath: vscode.Uri.joinPath(
      context.extensionUri,
      "resources",
      "icon.svg"
    ),
    env: {
      PAGER: "cat", // Disable paging to avoid issues with output
    },
  });
  logger.info("[getExtensionTerminal] Created new terminal for shell commands");
  context.subscriptions.push(sharedTerminal);

  return sharedTerminal;
}

// Function to update status bar
function updateStatusBar() {
  if (!statusBarItem) {
    return;
  }

  if (serverEnabled) {
    const isConnected = mcpServer?.isConnectedToClient() ?? false;
    if (isConnected) {
      statusBarItem.text = `$(server) BismuthVS: Connected`;
      statusBarItem.tooltip = `BismuthVS connected to client (Click to toggle)`;
      statusBarItem.backgroundColor = undefined;
    } else {
      statusBarItem.text = `$(server) BismuthVS: Connecting...`;
      statusBarItem.tooltip = `BismuthVS connecting to client (Click to toggle)`;
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
    }
  } else {
    statusBarItem.text = `$(server) BismuthVS: Off`;
    statusBarItem.tooltip = `BismuthVS is disabled (Click to toggle)`;
    // Use a subtle color to indicate disabled state
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  }
  statusBarItem.show();
}

// Function to toggle server state
async function toggleServerState(
  context: vscode.ExtensionContext
): Promise<void> {
  logger.info(
    `[toggleServerState] Starting toggle operation - changing from ${serverEnabled} to ${!serverEnabled}`
  );

  serverEnabled = !serverEnabled;

  // Store state for persistence
  context.globalState.update("mcpServerEnabled", serverEnabled);

  const config = vscode.workspace.getConfiguration("vscode-mcp-server");
  const apiKey = config.get<string>("apiKey") || "";

  // Update status bar immediately to provide feedback
  updateStatusBar();

  if (serverEnabled) {
    // Check if API key is configured
    if (!apiKey) {
      vscode.window.showErrorMessage(
        "Please configure your authentication token before enabling BismuthVS. Use the command palette: 'BismuthVS: Configure API Key'"
      );
      serverEnabled = false;
      context.globalState.update("mcpServerEnabled", false);
      updateStatusBar();
      return;
    }

    // Start the server if it was disabled
    if (!mcpServer) {
      logger.info(`[toggleServerState] Creating MCP server instance`);
      const terminal = getExtensionTerminal(context);
      const toolConfig = getToolConfiguration();
      const clientWebsocketBaseUrl = getClientWebsocketBaseUrl();
      mcpServer = new MCPServer(
        apiKey,
        clientWebsocketBaseUrl,
        terminal,
        toolConfig
      );
      mcpServer.setFileListingCallback(
        async (path: string, recursive: boolean, options?: any) => {
          try {
            return await listWorkspaceFiles(path, recursive, options);
          } catch (error) {
            logger.error(
              `[toggleServerState] Error listing files: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            throw error;
          }
        }
      );
      mcpServer.setupTools();

      logger.info(
        `[toggleServerState] Starting server at ${new Date().toISOString()}`
      );
      const startTime = Date.now();

      await mcpServer.start();

      const duration = Date.now() - startTime;
      logger.info(
        `[toggleServerState] Server started successfully at ${new Date().toISOString()} (took ${duration}ms)`
      );

      vscode.window.showInformationMessage(`BismuthVS connected successfully`);

      // Update status bar to show connected state
      updateStatusBar();
    }
  } else {
    // Stop the server if it was enabled
    if (mcpServer) {
      // Show progress indicator
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Stopping BismuthVS",
          cancellable: false,
        },
        async (progress) => {
          logger.info(
            `[toggleServerState] Stopping server at ${new Date().toISOString()}`
          );
          progress.report({ message: "Closing connections..." });

          const stopTime = Date.now();
          if (mcpServer) {
            await mcpServer.stop();
          }

          const duration = Date.now() - stopTime;
          logger.info(
            `[toggleServerState] Server stopped successfully at ${new Date().toISOString()} (took ${duration}ms)`
          );

          mcpServer = undefined;
        }
      );

      vscode.window.showInformationMessage("BismuthVS has been disabled");
    }
  }

  logger.info(`[toggleServerState] Toggle operation completed`);
}

export async function activate(context: vscode.ExtensionContext) {
  logger.info("Activating vscode-mcp-server extension");
  logger.showChannel(); // Show the output channel for easy access to logs

  try {
    // Get configuration
    const config = vscode.workspace.getConfiguration("vscode-mcp-server");
    const defaultEnabled = config.get<boolean>("defaultEnabled") ?? false;
    const apiKey = config.get<string>("apiKey") || "";

    // Load saved state or use configured default
    serverEnabled = context.globalState.get("mcpServerEnabled", defaultEnabled);

    // Force disable on startup to prevent auto-connect issues
    if (serverEnabled) {
      logger.info(
        "[activate] Server was previously enabled, but forcing to disabled state on startup"
      );
      serverEnabled = false;
      context.globalState.update("mcpServerEnabled", false);

      setTimeout(() => {
        // After a short delay, re-enable if configured to do so
        if (defaultEnabled) {
          vscode.commands.executeCommand("vscode-mcp-server.toggleServer");
        }
      }, 3000);
    }

    logger.info(`[activate] API key configured: ${apiKey ? "Yes" : "No"}`);
    logger.info(`[activate] Server enabled: ${serverEnabled}`);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    statusBarItem.command = "vscode-mcp-server.toggleServer";

    // Only start the server if enabled and API key is configured
    if (serverEnabled) {
      if (!apiKey) {
        logger.warn("[activate] API key not configured, disabling server");
        serverEnabled = false;
        context.globalState.update("mcpServerEnabled", false);
      } else {
        // Create the shared terminal
        const terminal = getExtensionTerminal(context);

        // Initialize MCP server with the API key, terminal, and tool configuration
        const toolConfig = getToolConfiguration();
        const clientWebsocketBaseUrl = getClientWebsocketBaseUrl();
        mcpServer = new MCPServer(
          apiKey,
          clientWebsocketBaseUrl,
          terminal,
          toolConfig
        );

        // Set up file listing callback
        mcpServer.setFileListingCallback(
          async (path: string, recursive: boolean, options?: any) => {
            try {
              return await listWorkspaceFiles(path, recursive, options);
            } catch (error) {
              logger.error(
                `Error listing files: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
              throw error;
            }
          }
        );

        // Call setupTools after setting the callback
        mcpServer.setupTools();

        await mcpServer.start();
        logger.info("BismuthVS started successfully");
      }
    } else {
      logger.info("BismuthVS is disabled by default");
    }

    // Update status bar after server state is determined
    updateStatusBar();

    // Register commands
    const toggleServerCommand = vscode.commands.registerCommand(
      "vscode-mcp-server.toggleServer",
      () => toggleServerState(context)
    );

    const showServerInfoCommand = vscode.commands.registerCommand(
      "vscode-mcp-server.showServerInfo",
      () => {
        if (serverEnabled) {
          const isConnected = mcpServer?.isConnectedToClient() ?? false;
          if (isConnected) {
            vscode.window.showInformationMessage(
              "BismuthVS is connected to the client"
            );
          } else {
            vscode.window.showInformationMessage(
              "BismuthVS is enabled but not connected to the client"
            );
          }
        } else {
          vscode.window.showInformationMessage(
            "BismuthVS is currently disabled. Click on the status bar item to enable it."
          );
        }
      }
    );

    const configureApiKeyCommand = vscode.commands.registerCommand(
      "vscode-mcp-server.configureApiKey",
      async () => {
        const apiKey = await vscode.window.showInputBox({
          prompt: "Enter your authentication token for BismuthVS",
          placeHolder: "Your authentication token",
          password: true,
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return "Token cannot be empty";
            }
            return null;
          },
        });

        if (apiKey) {
          // Save the API key to configuration
          const config = vscode.workspace.getConfiguration("vscode-mcp-server");
          await config.update(
            "apiKey",
            apiKey,
            vscode.ConfigurationTarget.Global
          );

          vscode.window.showInformationMessage(
            "Authentication token saved successfully!"
          );

          // If server was disabled due to missing API key, offer to enable it
          if (!serverEnabled) {
            const enableNow = await vscode.window.showInformationMessage(
              "Would you like to enable BismuthVS now?",
              "Yes",
              "No"
            );

            if (enableNow === "Yes") {
              await toggleServerState(context);
            }
          }
        }
      }
    );

    const openWebAppCommand = vscode.commands.registerCommand(
      "vscode-mcp-server.openWebApp",
      async () => {
        // Get the API key from configuration
        const config = vscode.workspace.getConfiguration("vscode-mcp-server");
        const apiKey = config.get<string>("apiKey") || "";

        if (!apiKey) {
          vscode.window.showErrorMessage(
            "Please configure your authentication token first. Use the command palette: 'BismuthVS: Configure API Key'"
          );
          return;
        }

        // If the server is not enabled, enable it first
        if (!serverEnabled) {
          vscode.window.showInformationMessage(
            "Enabling BismuthVS before opening web app..."
          );
          await toggleServerState(context);

          // Wait a moment for the server to start
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        // Create a webview panel
        const panel = vscode.window.createWebviewPanel(
          "bismuthWebApp",
          "Bismuth",
          vscode.ViewColumn.Beside,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
          }
        );

        // Set the webview's HTML content to load the localhost URL in an iframe
        const webAppUrl = `http://localhost:3000?codeEditorAPIKey=${encodeURIComponent(
          apiKey
        )}`;

        // Function to get the HTML content
        const getWebviewContent = () => `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <title>Bismuth</title>
            <style>
              body, html {
                margin: 0;
                padding: 0;
                height: 100vh;
                overflow: hidden;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              }
              .toolbar {
                height: 35px;
                background: var(--vscode-editor-background);
                border-bottom: 1px solid var(--vscode-panel-border);
                display: flex;
                align-items: center;
                padding: 0 10px;
                gap: 10px;
              }
              .toolbar button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 4px 12px;
                cursor: pointer;
                border-radius: 2px;
                font-size: 13px;
              }
              .toolbar button:hover {
                background: var(--vscode-button-hoverBackground);
              }
              .toolbar .info {
                color: var(--vscode-foreground);
                font-size: 12px;
                opacity: 0.8;
                margin-left: auto;
              }
              iframe {
                width: 100%;
                height: calc(100vh - 35px);
                border: none;
              }
            </style>
          </head>
          <body>
            <div class="toolbar">
              <button onclick="refreshPage()">↻ Refresh</button>
              <span class="info">Press Cmd/Ctrl+R to refresh</span>
            </div>
            <iframe 
              id="bismuthFrame" 
              src="${webAppUrl}" 
              title="Bismuth Web App"
              allow="clipboard-read; clipboard-write"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-clipboard-read allow-clipboard-write"
            ></iframe>
            <script>
              function refreshPage() {
                const iframe = document.getElementById('bismuthFrame');
                iframe.src = iframe.src;
              }
              
              // Listen for keyboard shortcuts
              document.addEventListener('keydown', (e) => {
                // Cmd+R or Ctrl+R
                if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
                  e.preventDefault();
                  refreshPage();
                }
                // F5
                if (e.key === 'F5') {
                  e.preventDefault();
                  refreshPage();
                }
              });
            </script>
          </body>
          </html>
        `;

        panel.webview.html = getWebviewContent();

        vscode.window.showInformationMessage(
          "Bismuth web app opened in VS Code. Use Cmd/Ctrl+R to refresh."
        );
      }
    );

    // Listen for configuration changes to restart server if needed
    const configChangeListener = vscode.workspace.onDidChangeConfiguration(
      async (event) => {
        if (event.affectsConfiguration("vscode-mcp-server.enabledTools")) {
          logger.info(
            "[configChangeListener] Tool configuration changed - restarting server if enabled"
          );
          if (serverEnabled && mcpServer) {
            // Stop current server
            await mcpServer.stop();
            mcpServer = undefined;

            // Start new server with updated configuration
            const config =
              vscode.workspace.getConfiguration("vscode-mcp-server");
            const apiKey = config.get<string>("apiKey") || "";

            if (!apiKey) {
              vscode.window.showErrorMessage(
                "Authentication token is required to restart BismuthVS"
              );
              serverEnabled = false;
              context.globalState.update("mcpServerEnabled", false);
              updateStatusBar();
              return;
            }

            const terminal = getExtensionTerminal(context);
            const toolConfig = getToolConfiguration();
            const clientWebsocketBaseUrl = getClientWebsocketBaseUrl();

            mcpServer = new MCPServer(
              apiKey,
              clientWebsocketBaseUrl,
              terminal,
              toolConfig
            );
            mcpServer.setFileListingCallback(
              async (path: string, recursive: boolean, options?: any) => {
                try {
                  return await listWorkspaceFiles(path, recursive, options);
                } catch (error) {
                  logger.error(
                    `[configChangeListener] Error listing files: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  );
                  throw error;
                }
              }
            );
            mcpServer.setupTools();
            await mcpServer.start();

            vscode.window.showInformationMessage(
              "BismuthVS restarted with updated tool configuration"
            );
          }
        }
      }
    );

    // Add all disposables to the context subscriptions
    context.subscriptions.push(
      statusBarItem,
      toggleServerCommand,
      showServerInfoCommand,
      configureApiKeyCommand,
      openWebAppCommand,
      configChangeListener,
      { dispose: async () => mcpServer && (await mcpServer.stop()) }
    );
  } catch (error) {
    logger.error(
      `Failed to start BismuthVS: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
    vscode.window.showErrorMessage(
      `Failed to start BismuthVS: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

export async function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = undefined;
  }

  // Dispose the shared terminal
  if (sharedTerminal) {
    sharedTerminal.dispose();
    sharedTerminal = undefined;
  }

  if (!mcpServer) {
    return;
  }

  try {
    logger.info("Stopping BismuthVS during extension deactivation");
    await mcpServer.stop();
    logger.info("BismuthVS stopped successfully");
  } catch (error) {
    logger.error(
      `Error stopping BismuthVS: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    throw error; // Re-throw to ensure VS Code knows about the failure
  } finally {
    mcpServer = undefined;
    // Dispose the logger
    logger.dispose();
  }
}
