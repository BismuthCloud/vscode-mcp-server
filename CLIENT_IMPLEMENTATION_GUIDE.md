# VSCode MCP Server - Client Implementation Guide

This document describes how to implement a WebSocket server that can accept connections from the VSCode MCP Server extension.

## Architecture Overview

The VSCode MCP Server uses an **inverted transport model**:
- **Transport Layer**: The VSCode extension acts as a WebSocket CLIENT (initiates outbound connection)
- **MCP Protocol Layer**: The VSCode extension acts as the MCP SERVER (provides tools and responds to requests)

This means your client application needs to:
1. Run a WebSocket server that accepts incoming connections
2. Act as an MCP client that sends requests and receives responses

## WebSocket Server Requirements

### 1. WebSocket Endpoint

Your WebSocket server must:
- Accept WebSocket connections at a specific URL (e.g., `ws://localhost:8765/mcp`)
- Support the standard WebSocket protocol (RFC 6455)
- Handle WebSocket frames containing JSON-RPC 2.0 messages

### 2. Authentication

The VSCode extension will send an API key in the WebSocket connection headers:

```
Authorization: Bearer <API_KEY>
```

Your server should:
- Validate the API key in the `Authorization` header during the WebSocket handshake
- Reject connections with invalid or missing API keys
- Return appropriate HTTP status codes (401 Unauthorized) for failed authentication

### 3. Message Format

All messages exchanged over the WebSocket connection must follow the JSON-RPC 2.0 specification:

```typescript
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
```

### 4. MCP Protocol Flow

Once connected, your client should follow the Model Context Protocol (MCP) specification:

1. **Initialize**: Send an `initialize` request to discover server capabilities
2. **Request Tools**: Use `tools/list` to discover available tools
3. **Call Tools**: Send `tools/call` requests to execute tools
4. **Handle Responses**: Process tool results and errors

## Example Implementation (Python)

Here's a minimal example using Python with `websockets` and `aiohttp`:

```python
import asyncio
import json
import websockets
from aiohttp import web

# Your API key validation
VALID_API_KEYS = {"your-secret-api-key"}

async def validate_api_key(path, headers):
    """Validate the API key from the Authorization header"""
    auth_header = headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return False
    
    api_key = auth_header[7:]  # Remove "Bearer " prefix
    return api_key in VALID_API_KEYS

async def handle_mcp_connection(websocket, path):
    """Handle MCP protocol communication"""
    try:
        # Connection established
        print("VSCode MCP Server connected")
        
        # Send initialize request
        initialize_request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "0.1.0",
                "capabilities": {},
                "clientInfo": {
                    "name": "example-client",
                    "version": "1.0.0"
                }
            }
        }
        await websocket.send(json.dumps(initialize_request))
        
        # Handle messages
        async for message in websocket:
            data = json.loads(message)
            print(f"Received: {data}")
            
            # Handle responses and notifications
            if "result" in data:
                # Handle successful responses
                if data.get("id") == 1:  # Initialize response
                    # Now you can list tools
                    list_tools_request = {
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/list",
                        "params": {}
                    }
                    await websocket.send(json.dumps(list_tools_request))
                elif data.get("id") == 2:  # Tools list response
                    tools = data["result"]["tools"]
                    print(f"Available tools: {tools}")
                    # You can now call these tools
            
            elif "error" in data:
                # Handle errors
                print(f"Error: {data['error']}")
                
    except websockets.exceptions.ConnectionClosed:
        print("VSCode MCP Server disconnected")
    except Exception as e:
        print(f"Error: {e}")

async def websocket_handler(websocket, path):
    """WebSocket connection handler with authentication"""
    # Validate API key from headers
    if not await validate_api_key(path, websocket.request_headers):
        await websocket.close(code=1008, reason="Unauthorized")
        return
    
    await handle_mcp_connection(websocket, path)

# Start WebSocket server
start_server = websockets.serve(
    websocket_handler,
    "localhost",
    8765,
    subprotocols=["mcp"]  # Optional: specify MCP subprotocol
)

asyncio.get_event_loop().run_until_complete(start_server)
asyncio.get_event_loop().run_forever()
```

## Example Implementation (Node.js)

Here's an example using Node.js with the `ws` library:

```javascript
const WebSocket = require('ws');

// Your API key validation
const VALID_API_KEYS = new Set(['your-secret-api-key']);

// Create WebSocket server
const wss = new WebSocket.Server({
  port: 8765,
  path: '/mcp',
  verifyClient: (info) => {
    // Validate API key
    const auth = info.req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return false;
    }
    
    const apiKey = auth.substring(7);
    return VALID_API_KEYS.has(apiKey);
  }
});

wss.on('connection', (ws) => {
  console.log('VSCode MCP Server connected');
  
  // Send initialize request
  const initializeRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '0.1.0',
      capabilities: {},
      clientInfo: {
        name: 'example-client',
        version: '1.0.0'
      }
    }
  };
  ws.send(JSON.stringify(initializeRequest));
  
  // Handle messages
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    console.log('Received:', data);
    
    if (data.result) {
      // Handle successful responses
      if (data.id === 1) {
        // Initialize response - now list tools
        const listToolsRequest = {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {}
        };
        ws.send(JSON.stringify(listToolsRequest));
      } else if (data.id === 2) {
        // Tools list response
        const tools = data.result.tools;
        console.log('Available tools:', tools);
        // You can now call these tools
      }
    } else if (data.error) {
      // Handle errors
      console.error('Error:', data.error);
    }
  });
  
  ws.on('close', () => {
    console.log('VSCode MCP Server disconnected');
  });
});

console.log('WebSocket server listening on ws://localhost:8765/mcp');
```

## Available Tools

The VSCode MCP Server provides the following tool categories (configurable):

1. **File Tools**: Read, write, and list files in the workspace
2. **Edit Tools**: Create, edit, and delete files
3. **Shell Tools**: Execute shell commands
4. **Diagnostics Tools**: Access VSCode diagnostics (errors, warnings)
5. **Symbol Tools**: Analyze code symbols and structure

## Testing Your Implementation

1. Configure the VSCode extension with your API key
2. Start your WebSocket server
3. Enable the MCP server in VSCode (click the status bar item)
4. Monitor the connection and message exchange
5. Send tool requests and handle responses

## Security Considerations

1. **API Key Storage**: Store API keys securely, never in plain text
2. **TLS/SSL**: Consider using `wss://` (WebSocket Secure) in production
3. **Rate Limiting**: Implement rate limiting to prevent abuse
4. **Input Validation**: Validate all incoming requests before processing
5. **Error Handling**: Don't expose internal errors to clients

## Troubleshooting

Common issues and solutions:

1. **Connection Refused**: Ensure your WebSocket server is running and accessible
2. **Authentication Failed**: Verify the API key is correct and properly formatted
3. **Protocol Errors**: Ensure all messages follow JSON-RPC 2.0 format
4. **Tool Errors**: Check VSCode logs for detailed error messages

## References

- [Model Context Protocol Specification](https://modelcontextprotocol.io/docs)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [WebSocket Protocol RFC 6455](https://tools.ietf.org/html/rfc6455)
