import restify from 'restify';
import DeltaSync from '../../src/server/index.mjs';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import pino from 'pino';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const server = restify.createServer({
  handleUpgrades: true
});


const deltaSync = new DeltaSync({
  path: false,
  directory: '../files',
  log: pino({
    level: 10
  })
});


deltaSync.pre(async (req, socket, head) => {
  // console.log('pre-1', req.route)
  return true;
})

server.get('/api/.delta-sync/:id', async (req, res) => {
  if (!res.claimUpgrade) {
    throw new Error('Connection Must Upgrade For WebSockets');
  }
  // const upgrade = res.claimUpgrade();

  await deltaSync.handleUpgrade(req, req.socket, res._upgrade.head);
})

// deltaSync.pre(async (req, socket, head) => {
//   console.log('pre-2')
//   return true;
// })
// deltaSync.pre(async (req, socket, head) => {
//   console.log('pre-3')
//   return true;
// })
// deltaSync.pre(async (req, socket, head) => {
//   console.log('pre-4')
//   return true;
// })

// deltaSync.attach(server);

server.pre((req, res, next) => {

  if (! req.route ){
    req.route = {};
  }

  req.route.foobar = {
    d: new Date(),
    that: 'this--',
    f: 1324,
  };

  const d = new Date(Date.now() + 100000000).toISOString();
  res.header('set-cookie', `token=foobar; Max-Age=10000000; Expires=${d}; Path=/`);
  return next();
})

// server.get('/*',  restify.plugins.serveStaticFiles('./'));
server.get('/',  async (req, res) => {
  const content = await fs.readFile(path.join(__dirname, '../index.html'));
  res.sendRaw(content)
});


server.get('/client/index.js',  async (req, res) => {
  const content = await fs.readFile(path.join(__dirname, '../../client/index.js'));
  res.header('content-type', 'application/javascript')
  res.sendRaw(content)
});


const port = 9000;

server.listen(port, function (){
  console.log('Server started on port', port)
});




