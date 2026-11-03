/** stdout carries MCP protocol frames only. Every diagnostic goes to stderr. */
export function log(...parts: unknown[]): void {
  console.error("[closeloop-mcp]", ...parts);
}
