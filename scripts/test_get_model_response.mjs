import http from 'node:http';

const port = 33379;
const path = '/exa.language_server_pb.LanguageServerService/GetModelResponse';

console.log(`Connecting to Connect-RPC endpoint at http://127.0.0.1:${port}${path}...`);

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
  });
  
  res.on('end', () => {
    console.log(`Received ${buffer.length} bytes.`);
    if (buffer.length >= 5) {
      const flags = buffer.readUInt8(0);
      const len = buffer.readUInt32BE(1);
      const payload = buffer.subarray(5, 5 + len);
      console.log(`Flags: ${flags}, Length: ${len}`);
      try {
        console.log('Response JSON:', JSON.parse(payload.toString('utf8')));
      } catch (e) {
        console.log('Response raw:', payload.toString('utf8'));
      }
    } else {
      console.log('Response empty or too short:', buffer.toString('utf8'));
    }
  });
});

req.on('error', (e) => {
  console.error('Request error:', e);
});

const payloadObj = {
  prompt: "证明：任何奇素数 p 都可以表示为两个连续整数的平方差。如果要求 x, y 必须是正整数，请详述你的推导思考过程。",
  model: "Gemini 3.5 Flash (Medium)"
};

const framedPayload = frameMessage(payloadObj);
console.log(`Sending payload: ${JSON.stringify(payloadObj)}`);
req.write(framedPayload);
req.end();
