const http = require('http');

const server = http.createServer((req, res) => {
  console.log('Local server received:', req.method, req.url);

  const response = JSON.stringify({
    message: 'Hello from local server!',
    path: req.url,
    timestamp: new Date().toISOString()
  });

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(response)
  });
  res.end(response);
});

server.listen(3000, () => {
  console.log('Test server listening on http://localhost:3000');
});
