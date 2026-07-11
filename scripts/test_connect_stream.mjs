import http from 'node:http';

const port = 33379;
const path = '/exa.language_server_pb.LanguageServerService/SubscribeToSidecars';

console.log(`Connecting to Connect-RPC stream at http://127.0.0.1:${port}${path}...`);

function frameMessage(jsonObj) {
  const jsonStr = JSON.stringify(jsonObj);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const headerBuf = Buffer.alloc(5);
  headerBuf.writeUInt8(0, 0); // flags
  headerBuf.writeUInt32BE(jsonBuf.length, 1); // length
  return Buffer.concat([headerBuf, jsonBuf]);
}

const req = http.request({
  hostname: '127.0.0.1',
  port: port,
  path: path,
  method: 'POST',
  headers: {
    'Content-Type': 'application/connect+json',
    'Accept': 'application/connect+json'
  }
}, (res) => {
  console.log(`Status Code: ${res.statusCode}`);
  console.log('Headers:', res.headers);
  
  let buffer = Buffer.alloc(0);
  
  res.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    console.log(`[STREAM] Received ${chunk.length} bytes. Total buffer: ${buffer.length} bytes.`);
    
    while (buffer.length >= 5) {
      const flags = buffer.readUInt8(0);
      const len = buffer.readUInt32BE(1);
      
      if (buffer.length >= 5 + len) {
        const payload = buffer.subarray(5, 5 + len);
        buffer = buffer.subarray(5 + len);
        
        const isEndStream = (flags & 2) !== 0; // connect-rpc EOS flag
        console.log(`[FRAME] Flags: ${flags} (EndStream: ${isEndStream}), Length: ${len}`);
        
        try {
          const text = payload.toString('utf8');
          console.log('[PAYLOAD JSON]:', JSON.parse(text));
        } catch (e) {
          console.log('[PAYLOAD HEX]:', payload.toString('hex'));
        }
      } else {
        break; // Wait for more data
      }
    }
  });
  
  res.on('end', () => {
    console.log('Stream ended by server.');
  });
});

req.on('error', (e) => {
  console.error('Request error:', e);
});

// Write the structured framed payload
const framedPayload = frameMessage({});
console.log(`Sending framed payload: ${framedPayload.toString('hex')}`);
req.write(framedPayload);
req.end();
