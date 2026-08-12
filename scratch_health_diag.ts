import { isBackendAvailable } from './src/core/backendHealth.js';

function checkHealth() {
  console.log('=== 检查后端可用性 ===');
  console.log('agy (Google Antigravity CLI) channel available?:', isBackendAvailable('agy'));
  console.log('web2api channel available?:', isBackendAvailable('web2api'));
  console.log('deepseek channel available?:', isBackendAvailable('deepseek'));
  console.log('opencode channel available?:', isBackendAvailable('opencode'));
}

checkHealth();
