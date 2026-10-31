import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function serve(service, root) {
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    const send = (code, result) => { response.writeHead(code); response.end(JSON.stringify(result)); };
    const supplied = request.headers.authorization || '';
    const expected = `Bearer ${token}`;
    if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return send(401, { error: 'Authentication required.' });
    if (request.headers.origin || request.headers.host !== `127.0.0.1:${server.address().port}`) return send(403, { error: 'Remote origins are not allowed.' });
    if (request.method !== 'POST' || request.url !== '/command') return send(404, { error: 'Endpoint was not found.' });
    try {
      let body = '', size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) { send(413, { error: 'Request is too large.' }); return; }
        body += chunk.toString('utf8');
      }
      const { command, args } = JSON.parse(body);
      send(200, { result: await service.execute(command, args) });
    } catch (error) { send(400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ port: server.address().port, token }), { mode: 0o600 });
  return server;
}
