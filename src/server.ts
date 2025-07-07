import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebSocketTransport } from "./websocket-transport";
import { registerFileTools, FileListingCallback } from "./tools/file-tools";
import { registerEditTools } from "./tools/edit-tools";
import { registerShellTools } from "./tools/shell-tools";
import { registerDiagnosticsTools } from "./tools/diagnostics-tools";
import { registerSymbolTools } from "./tools/symbol-tools";
import { registerSearchTools } from "./tools/search-tools";
import { registerWorkspaceTools } from "./tools/workspace-tools";
import { logger } from "./utils/logger";

export interface ToolConfiguration {
  file: boolean;
  edit: boolean;
  shell: boolean;
  diagnostics: boolean;
  symbol: boolean;
  search: boolean;
}

export class MCPServer {
  private server: McpServer;
  private transport?: WebSocketTransport;
  private fileListingCallback?: FileListingCallback;
  private terminal?: vscode.Terminal;
  private toolConfig: ToolConfiguration;
  private apiKey: string;
  private clientWebsocketBaseUrl: string;
  private isConnected: boolean = false;

  public setFileListingCallback(callback: FileListingCallback) {
    this.fileListingCallback = callback;
  }

  constructor(
    apiKey: string,
    clientWebsocketBaseUrl: string,
    terminal?: vscode.Terminal,
    toolConfig?: ToolConfiguration
  ) {
    this.apiKey = apiKey;
    this.clientWebsocketBaseUrl = clientWebsocketBaseUrl;
    this.terminal = terminal;
    this.toolConfig = toolConfig || {
      file: true,
      edit: true,
      shell: true,
      diagnostics: true,
      symbol: true,
      search: true,
    };

    // Initialize MCP Server
    this.server = new McpServer(
      {
        name: "vscode-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          logging: {},
          tools: {
            listChanged: false,
          },
        },
      }
    );
  }

  public setupTools(): void {
    // Register tools from the tools module based on configuration
    if (this.fileListingCallback) {
      logger.info(
        `Setting up MCP tools with configuration: ${JSON.stringify(
          this.toolConfig
        )}`
      );

      // Register file tools if enabled
      if (this.toolConfig.file) {
        registerFileTools(this.server, this.fileListingCallback);
        logger.info("MCP file tools registered successfully");
      } else {
        logger.info("MCP file tools disabled by configuration");
      }

      // Register edit tools if enabled
      if (this.toolConfig.edit) {
        registerEditTools(this.server);
        logger.info("MCP edit tools registered successfully");
      } else {
        logger.info("MCP edit tools disabled by configuration");
      }

      // Register shell tools if enabled
      if (this.toolConfig.shell) {
        registerShellTools(this.server, this.terminal);
        logger.info("MCP shell tools registered successfully");
      } else {
        logger.info("MCP shell tools disabled by configuration");
      }

      // Register diagnostics tools if enabled
      if (this.toolConfig.diagnostics) {
        registerDiagnosticsTools(this.server);
        logger.info("MCP diagnostics tools registered successfully");
      } else {
        logger.info("MCP diagnostics tools disabled by configuration");
      }

      // Register symbol tools if enabled
      if (this.toolConfig.symbol) {
        registerSymbolTools(this.server);
        logger.info("MCP symbol tools registered successfully");
      } else {
        logger.info("MCP symbol tools disabled by configuration");
      }

      // Register search tools if enabled
      if (this.toolConfig.search) {
        registerSearchTools(this.server);
        logger.info("MCP search tools registered successfully");
      } else {
        logger.info("MCP search tools disabled by configuration");
      }

      // Always register workspace tools (internal tool for programmatic use)
      registerWorkspaceTools(this.server);
      logger.info("MCP workspace tools registered successfully");
    } else {
      logger.warn("File listing callback not set during tools setup");
    }
  }

  public async start(): Promise<void> {
    try {
      logger.info("[MCPServer.start] Starting MCP server connection");
      const startTime = Date.now();

      // Create WebSocket transport with URL including token as query parameter
      const wsUrl = `${this.clientWebsocketBaseUrl}?token=${encodeURIComponent(
        this.apiKey
      )}`;
      this.transport = new WebSocketTransport(wsUrl);

      // Set up transport event handlers
      this.transport.onclose = () => {
        logger.info("[MCPServer] WebSocket connection closed");
        this.isConnected = false;
      };

      this.transport.onerror = (error: Error) => {
        logger.error(`[MCPServer] WebSocket error: ${error.message}`);
        this.isConnected = false;
      };

      // Start the transport (connect to client)
      logger.info("[MCPServer.start] Connecting to client WebSocket");
      await this.transport.start();

      // Connect MCP server to transport
      logger.info("[MCPServer.start] Connecting MCP server to transport");
      await this.server.connect(this.transport as any);

      // Add a short delay to allow the server to fully initialize
      await new Promise((resolve) => setTimeout(resolve, 1000));

      this.isConnected = true;
      const totalTime = Date.now() - startTime;
      logger.info(
        `[MCPServer.start] MCP Server connected successfully (total: ${totalTime}ms)`
      );
    } catch (error) {
      logger.error(
        `[MCPServer.start] Failed to connect MCP Server: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }

  public async stop(): Promise<void> {
    logger.info("[MCPServer.stop] Starting server shutdown process");
    const stopStartTime = Date.now();

    try {
      // Close transport
      if (this.transport) {
        logger.info("[MCPServer.stop] Closing transport");
        const transportCloseStart = Date.now();
        await this.transport.close();
        const transportCloseTime = Date.now() - transportCloseStart;
        logger.info(
          `[MCPServer.stop] Transport closed (took ${transportCloseTime}ms)`
        );
      }

      // Close MCP server
      logger.info("[MCPServer.stop] Closing MCP server");
      const serverCloseStart = Date.now();
      await this.server.close();
      const serverCloseTime = Date.now() - serverCloseStart;
      logger.info(
        `[MCPServer.stop] MCP server closed (took ${serverCloseTime}ms)`
      );

      this.isConnected = false;
      const totalStopTime = Date.now() - stopStartTime;
      logger.info(
        `[MCPServer.stop] MCP Server shutdown complete (total: ${totalStopTime}ms)`
      );
    } catch (error) {
      logger.error(
        `[MCPServer.stop] Error during server shutdown: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }

  public isConnectedToClient(): boolean {
    return this.isConnected && (this.transport?.isConnected() ?? false);
  }
}
