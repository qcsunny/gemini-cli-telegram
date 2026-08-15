import type { KnipConfig } from 'knip';

/**
 * tools/sqlite-mcp is a standalone MCP server package (own package.json +
 * bin entry) that resolves @modelcontextprotocol/sdk from the root
 * node_modules. Exclude it from the root project's unused-code report.
 */
const config: KnipConfig = {
  ignoreDependencies: ['@modelcontextprotocol/sdk'],
  ignore: ['tools/**'],
};

export default config;
