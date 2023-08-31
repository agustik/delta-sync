import restify from 'restify';
import DeltaSync from '../../src/server/index.mjs';



const server = restify.createServer({
  handleUpgrades: true
});


const deltaSync = new DeltaSync({
  path: false,
});


deltaSync.pre(async (req, socket, head) => {
  // console.log('pre-1', req.route)
  return true;
})

server.get('/api/.delta-sync/:id', async (req, res) => {
  if (!res.claimUpgrade) {
    throw new Error('Connection Must Upgrade For WebSockets');
  }

  console.log('Got upgrade request', res._upgrade)
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

server.get('/*',  restify.plugins.serveStaticFiles('./'));


const port = 9000;

server.listen(port, function (){
  console.log('Server started on port', port)
});




