import restify from 'restify';
import DeltaSync from '../../src/delta-sync/server/index.mjs';



const server = restify.createServer();


const deltaSync = new DeltaSync({
  directory: 'files/d1',
  path: '/api/.delta-sync/:id'
});


// deltaSync.pre(async (req, socket, head) => {
//   console.log('pre-1')
//   return true;
// })
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

deltaSync.attach(server);

server.pre((req, res, next) => {
  const d = new Date(Date.now() + 100000000).toISOString();
  res.header('set-cookie', `token=foobar; Max-Age=10000000; Expires=${d}; Path=/`);
  return next();
})

server.get('/*',  restify.plugins.serveStaticFiles('./'));


server.listen(9000);




