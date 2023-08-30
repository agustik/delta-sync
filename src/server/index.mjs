import assert from 'assert-plus';
import { WebSocketServer } from 'ws';
import SyncRequest from './sync-request/index.mjs';
import defaultCallbacks from './default-callbacks/index.mjs';
import { Path } from 'path-parser'

import pino from 'pino';



function parseQuery(url) {
  const u = new URL(url);

  const keys = u.searchParams.keys();

  const output = {};

  for (const key of keys) {
    output[key] = u.searchParams.get(key);
  }
  return output;
}



function parseJson(string){
  try {
    return JSON.parse(string);
  } catch (error) {
    return false;
  }
}

function messageParser(bufferMessage){
  const sep = Buffer.from('\r\r');
  const index = bufferMessage.indexOf(sep);

  if (index < 0) {
    return new Error(`No header in message`);
  }
  const header = bufferMessage.subarray(0, index);
  const payload = bufferMessage.subarray(index + sep.length);

  return {
    header: parseJson(header.toString()),
    payload,
  }  
}


class DeltaSync {
  constructor(opts) {
    assert.object(opts, 'opts');
    assert.optionalString(opts.directory, 'opts.directory')
    const self = this;
    this.path = opts.path || '/api/.delta-sync';
    const dir = opts.directory || '.';
    const log = opts.log || pino();

    this.preCallbacks = [];

    this.log = log;

    const callbacks = defaultCallbacks(dir);

    if (typeof opts.loadFile === 'function'){
      callbacks.loadFile = opts.loadFile;
    }
    if (typeof opts.saveFile === 'function') {
      callbacks.saveFile = opts.saveFile;
    }
    if (typeof opts.statFile === 'function') {
      callbacks.statFile = opts.statFile;
    }

    if (typeof opts.onComplete === 'function') {
      callbacks.onComplete = opts.onComplete;
    }


    const wss = new WebSocketServer({ noServer: true });

    this.wss = wss;

    wss.on('connection', function connection(ws) {
      
      log.debug({
        params: self.params,
        query: self.query,
        headers: self.headers,
      },`New webscoket connection`);
      ws.on('error', log.error);
      ws.on('message', (message, isBinary) => {

        if (! isBinary) return log.error('Only binary messages supported', {
          message, isBinary
        });

        const data = messageParser(message);

        if (!ws.syncRequest) {
          ws.syncRequest = new SyncRequest({
            ws,
            dir,
            log,
            params: self.params,
            query: self.query,
            headers: self.headers,
            loadFile: callbacks.loadFile,
            saveFile: callbacks.saveFile,
            statFile: callbacks.statFile,
            onComplete: callbacks.onComplete,
          });
        }
        const syncReq = ws.syncRequest;
        return syncReq.handle(data);
      });
    });
  }
  pre(callback) {
    this.preCallbacks.push(callback);
  }
  async runPre(req, socket, head) {
    const callbacks = this.preCallbacks;

    if (callbacks.length < 1) return true;

    const resp = await Promise.all(callbacks.map(callback => {
      return callback(req, socket, head);
    }));
    return resp.some(r => r);
  }
  attach(server) {
    const log = this.log;  
    const wss = this.wss;
    const self = this;

    const pathParser = new Path(this.path);

    
    server.on('upgrade', async (req, socket, head) => {      
      self.headers = req.headers;
      self.query = parseQuery(`http://psudo${req.url}`);
      const pathname = new URL(`http://psudo${req.url}`).pathname;
      const params = pathParser.test(pathname);
      
      req.deltaSync = {
        pathname,
        params,
        query: self.query
      };

      const preReq = await self.runPre(req, socket, head);

      if ( ! preReq ){
        return log.warn(`Pre runs did not all return true`);
      }

      this.params = params;

      if (!params) {
        return log.error({pathname}, `Got ws on ${pathname} but configured for ${self.path}, skipping`)
      }
      wss.handleUpgrade(req, socket, head, function done(ws) {
        wss.emit('connection', ws, req);
      });
    });
  }
}

export default DeltaSync;