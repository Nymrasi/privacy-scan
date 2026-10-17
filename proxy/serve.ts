// Local runner: node proxy/serve.ts [port]. Reads BLOCKSCOUT_PRO_KEY from the environment.
import { createServer } from 'node:http';
import { handle } from './proxy.ts';

const port = Number(process.argv[2] ?? 8787);
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const r = await handle(new Request(`http://localhost${req.url}`, { method: req.method, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), { BLOCKSCOUT_PRO_KEY: process.env.BLOCKSCOUT_PRO_KEY });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, '127.0.0.1');
