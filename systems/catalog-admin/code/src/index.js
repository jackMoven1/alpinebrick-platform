const http = require('http');

const PORT = process.env.PORT || 3001;

const requestHandler = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ service: 'catalog-admin', status: 'ok' }));
};

const server = http.createServer(requestHandler);
server.listen(PORT, () => {
  console.log(`catalog-admin listening on port ${PORT}`);
});
