import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BridgeError } from './runtime.mjs';
import { nativeToolResult } from './content.mjs';

// Low-level MCP handlers preserve arbitrary JSON Schema (including $defs/oneOf),
// without a lossy JSON Schema -> Zod -> JSON Schema conversion.
export function memberMcpServer(sdk, definitions, ctx) {
  const config=sdk.createSdkMcpServer({name:'member',version:'1.0.0',tools:[]});
  const server=config.instance.server;
  server.registerCapabilities({tools:{}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:definitions.map(t=>({name:t.name,description:t.description,inputSchema:t.parameters}))}));
  server.setRequestHandler(CallToolRequestSchema,async req=>{
    const tool=definitions.find(t=>t.name===req.params.name);
    if(!tool) throw new BridgeError('UNDECLARED_TOOL','Tool was not declared by the member');
    const content=await ctx.tool(tool.name,req.params.arguments??{});
    return nativeToolResult(content,ctx.signal);
  });
  return config;
}
