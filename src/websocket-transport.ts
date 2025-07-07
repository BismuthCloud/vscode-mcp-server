import * as vscode from "vscode";
import WebSocket from "ws";
import { logger } from "./utils/logger";

interface JSONRPCMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface Transport {
  start(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
}

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private connected: boolean = false;
  private messageQueue: JSONRPCMessage[] = [];
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 20;
  private reconnectDelay: number = 1000; // Start with 1 second
  private isReconnecting: boolean = false;
  private explicitlyClosed: boolean = false;

  // Callbacks set by MCP server
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private url: string) {
    // Log URL with token masked
    const maskedUrl = this.url.replace(/token=[^&]+/, "token=***");
    logger.info(`[WebSocketTransport] Created with URL: ${maskedUrl}`);
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const maskedUrl = this.url.replace(/token=[^&]+/, "token=***");
        logger.info(
          `[WebSocketTransport] Starting connection to: ${maskedUrl}`
        );

        this.ws = new WebSocket(this.url);
        logger.info(`[WebSocketTransport] WebSocket instance created`);

        this.ws.on("open", () => {
          logger.info(`[WebSocketTransport] WebSocket connection opened`);
          this.connected = true;
          this.reconnectAttempts = 0;
          this.reconnectDelay = 1000;
          this.isReconnecting = false;

          // Send any queued messages
          if (this.messageQueue.length > 0) {
            logger.info(
              `[WebSocketTransport] Sending ${this.messageQueue.length} queued messages`
            );
          }
          while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift()!;
            const messageStr = JSON.stringify(message);
            logger.info(
              `[WebSocketTransport] Sending queued message: ${messageStr.substring(
                0,
                200
              )}...`
            );
            this.ws?.send(messageStr);
          }

          resolve();
        });

        this.ws.on("message", (data: WebSocket.Data) => {
          try {
            const dataStr = data.toString();
            logger.info(
              `[WebSocketTransport] Received message: ${dataStr.substring(
                0,
                200
              )}${dataStr.length > 200 ? "..." : ""}`
            );

            const message = JSON.parse(dataStr) as JSONRPCMessage;

            // Skip non-MCP messages (like connection confirmations)
            if (message.jsonrpc === "2.0") {
              if (this.onmessage) {
                logger.info(
                  `[WebSocketTransport] Processing JSONRPC 2.0 message with method: ${
                    message.method || "response"
                  }, id: ${message.id || "none"}, error: ${
                    message.error ? JSON.stringify(message.error) : "none"
                  }`
                );

                try {
                  this.onmessage(message);
                } catch (handlerError) {
                  // Catch any errors from the message handler to prevent connection death
                  logger.error(
                    `[WebSocketTransport] Error in message handler: ${handlerError}`
                  );
                  // Don't propagate the error - just log it
                  // The connection should remain open
                }
              } else {
                logger.warn(
                  `[WebSocketTransport] Received JSONRPC message but no handler set`
                );
              }
            } else {
              logger.info(
                `[WebSocketTransport] Skipping non-JSONRPC 2.0 message`
              );
            }
          } catch (error) {
            logger.error(
              `[WebSocketTransport] Failed to parse message: ${error}`
            );
            // Don't call onerror for parse errors - just log them
            // This prevents the connection from being terminated
          }
        });

        this.ws.on("close", (code: number, reason: string) => {
          logger.info(
            `[WebSocketTransport] WebSocket closed with code: ${code}, reason: ${reason}`
          );
          this.connected = false;
          this.ws = null;
          this.onclose?.();

          if (!this.explicitlyClosed) {
            this.reconnect();
          }
        });

        this.ws.on("error", (error: Error) => {
          logger.error(
            `[WebSocketTransport] WebSocket error: ${error.message}`
          );
          logger.error(`[WebSocketTransport] Error stack: ${error.stack}`);

          // Only reject during initial connection
          // After connection is established, just log errors
          if (!this.connected) {
            this.connected = false;
            this.onerror?.(error);
            reject(error);
          } else {
            // Connection already established - don't kill it
            logger.error(
              `[WebSocketTransport] Error occurred on established connection - keeping connection alive`
            );
            // Still notify about the error but don't close the connection
            this.onerror?.(error);
          }
        });

        // Add additional event handlers for debugging
        this.ws.on("upgrade", (response) => {
          logger.info(
            `[WebSocketTransport] WebSocket upgrade response status: ${response.statusCode}`
          );
        });

        this.ws.on("unexpected-response", (request, response) => {
          logger.error(
            `[WebSocketTransport] Unexpected response status: ${response.statusCode}`
          );
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => {
            logger.error(`[WebSocketTransport] Response body: ${body}`);
          });
        });
      } catch (error) {
        logger.error(
          `[WebSocketTransport] Failed to create WebSocket: ${error}`
        );
        reject(error);
      }
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const messageStr = JSON.stringify(message);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.info(
        `[WebSocketTransport] Not connected, queueing message: ${messageStr.substring(
          0,
          200
        )}...`
      );
      this.messageQueue.push(message);
      return;
    }

    try {
      logger.info(
        `[WebSocketTransport] Sending message: ${messageStr.substring(
          0,
          200
        )}...`
      );
      this.ws.send(messageStr);
    } catch (error) {
      logger.error(`[WebSocketTransport] Failed to send message: ${error}`);

      // Check if this is an error response - those should not kill the connection
      if (message.error) {
        logger.info(
          `[WebSocketTransport] Failed to send error response, but keeping connection alive`
        );
        // Don't throw for error responses - just log and continue
        return;
      }

      // For other send failures, still throw but with more context
      throw new Error(`Failed to send message: ${error}`);
    }
  }

  async close(): Promise<void> {
    this.explicitlyClosed = true;
    if (this.ws) {
      logger.info(`[WebSocketTransport] Closing WebSocket connection`);
      this.connected = false;
      this.ws.close();
      this.ws = null;
    } else {
      logger.info(
        `[WebSocketTransport] Close called but WebSocket already null`
      );
    }
  }

  // Helper method to check connection status
  isConnected(): boolean {
    const isConnected =
      this.connected && this.ws?.readyState === WebSocket.OPEN;
    logger.info(
      `[WebSocketTransport] Connection status check: ${isConnected} (connected: ${this.connected}, readyState: ${this.ws?.readyState})`
    );
    return isConnected;
  }

  // Helper method to reconnect
  async reconnect(): Promise<void> {
    if (this.isReconnecting) {
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      logger.error(
        `[WebSocketTransport] Max reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`
      );
      this.isReconnecting = false;
      vscode.window.showErrorMessage(
        "Failed to connect to Bismuth after multiple attempts. The extension has been disabled."
      );
      vscode.commands.executeCommand("vscode-mcp-server.toggleServer");
      return;
    }

    logger.info(
      `[WebSocketTransport] Reconnecting... Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`
    );

    setTimeout(async () => {
      try {
        await this.start();
      } catch (error) {
        logger.error(`[WebSocketTransport] Reconnect attempt failed: ${error}`);
        this.isReconnecting = false;
        this.reconnect(); // Schedule next attempt
      }
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay *= 2;
  }
}
