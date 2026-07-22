import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';

const TEST_PORT = 19099;

describe('healthServer', () => {
  afterAll(async () => {
    const { stopHealthServer } = await import('./healthServer.js');
    stopHealthServer();
  });

  it('should respond with 200 and JSON status on GET /health', async () => {
    const { startHealthServer } = await import('./healthServer.js');
    startHealthServer(TEST_PORT);

    // Small delay for server to bind
    await new Promise(r => setTimeout(r, 100));

    const body = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });

    const parsed = JSON.parse(body);
    expect(parsed).toHaveProperty('status', 'ok');
    expect(parsed).toHaveProperty('uptime');
    expect(typeof parsed.uptime).toBe('number');
    expect(parsed).toHaveProperty('uptimeHuman');
  });

  it('should return 404 for unknown paths', async () => {
    const { startHealthServer } = await import('./healthServer.js');
    startHealthServer(TEST_PORT);

    await new Promise(r => setTimeout(r, 50));

    const statusCode = await new Promise<number>((resolve, reject) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/`, (res) => {
        resolve(res.statusCode ?? 0);
      }).on('error', reject);
    });

    expect(statusCode).toBe(404);
  });
});
