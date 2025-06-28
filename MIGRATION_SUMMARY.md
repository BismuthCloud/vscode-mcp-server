# VSCode MCP Server - WebSocket Transport Migration Summary

## Overview

The VSCode MCP Server has been migrated from using StreamableHTTPServerTransport to WebSocketTransport with an inverted connection model for improved security.

## Key Changes

### 1. **Inverted Transport Model**
- **Before**: VSCode extension ran an HTTP server listening for incoming connections
- **After**: VSCode extension acts as a WebSocket client that connects outbound to the MCP client

### 2. **Authentication**
- **Before**: No authentication (relied on localhost security)
- **After**: API key authentication via `Authorization: Bearer <API_KEY>` header

### 3. **Configuration Changes**
- **Removed**: `vscode-mcp-server.port` setting
- **Added**: `vscode-mcp-server.apiKey` setting (required)

### 4. **Dependencies**
- **Removed**: `express`, `@types/express`
- **Added**: `ws` (WebSocket library)

### 5. **Status Bar Updates**
- Shows connection status: "Connected", "Connecting...", or "Off"
- No longer shows port information

## Architecture

```
┌─────────────────────┐         ┌─────────────────────┐
│   VSCode Extension  │         │    MCP Client       │
│                     │         │                     │
│  ┌───────────────┐  │         │  ┌───────────────┐  │
│  │  MCP Server   │  │         │  │  WebSocket    │  │
│  │  (Tools)      │  │         │  │  Server       │  │
│  └───────────────┘  │         │  └───────────────┘  │
│          │          │         │          ▲          │
│  ┌───────────────┐  │         │          │          │
│  │  WebSocket    │  │ ────────┼──────────┘          │
│  │  Client       │  │  Connect with API Key         │
│  └───────────────┘  │         │                     │
└─────────────────────┘         └─────────────────────┘
```

## Usage

### 1. Configure API Key
Users must configure their API key in VSCode settings:
- Open VSCode Settings (Cmd/Ctrl + ,)
- Search for "vscode-mcp-server.apiKey"
- Enter the API key provided by your MCP client

### 2. Enable the Server
Click the status bar item or use the command palette:
- Command: "Toggle MCP Server"
- Status bar will show connection status

### 3. Client Implementation
The MCP client must implement a WebSocket server that:
- Accepts connections with Bearer token authentication
- Communicates using the MCP protocol over JSON-RPC 2.0
- See `CLIENT_IMPLEMENTATION_GUIDE.md` for details

## Files Modified

1. **src/server.ts**
   - Removed HTTP/Express server code
   - Simplified to use WebSocketTransport as outbound client
   - Added connection status tracking

2. **src/websocket-transport.ts**
   - Updated to support API key authentication
   - Removed session ID logic

3. **src/extension.ts**
   - Updated to use API key instead of port
   - Enhanced status bar to show connection status
   - Added API key validation

4. **package.json**
   - Removed port configuration
   - Added apiKey configuration
   - Updated dependencies

## Security Benefits

1. **No Incoming Connections**: VSCode doesn't expose any ports
2. **Authentication**: API key required for all connections
3. **Explicit Trust**: User must configure API key to connect
4. **Reduced Attack Surface**: No HTTP server running locally

## Next Steps

1. Update the `CLIENT_WEBSOCKET_URL` constant in `src/server.ts` with the actual client URL
2. Consider adding reconnection logic for dropped connections
3. Add TLS support (wss://) for production use
4. Implement connection timeout handling
