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
  constructor(options) {
    assert.optionalObject(options, 'options');
    const opts = options || {};
    assert.optionalString(opts.directory, 'opts.directory')
    const self = this;
    this.path = (opts.path === undefined) ? '/api/.delta-sync' : opts.path;
    const dir = opts.directory || '.';
    const log = opts.log || pino({
      level: 20
    });

    this.preCallbacks = [];

    this.log = log;

    this.requestObject = {};

    const callbacks = defaultCallbacks(dir, log);

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
      },`[DeltaSync] New webscoket connection`);
      ws.on('error', (err) => {
        log.error({
          error: err.toString(),
        },`[DeltaSync] Got Websocket error`);
      });
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
            requestObject: self.requestObject,
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
    const self = this;

    if (callbacks.length < 1) return true;

    const resp = await Promise.all(callbacks.map(callback => {
      return callback(req, socket, head, self.requestObject);
    }));
    return resp.some(r => r);
  }
  async handleUpgrade(req, socket, head){
    
    const log = this.log;
    const wss = this.wss;
    this.params = req.params;
    this.query = req.query;
    this.headers = req.headers;
    const pathname = new URL(`http://psudo${req.url}`).pathname;
    if (!this.params) {
      this.params = new Path(this.path).test(pathname);
      if (!this.params) {
        return log.error({ pathname }, `Got ws on ${pathname} but configured for ${this.path}, skipping`)
      }
    }
    
    if (! this.query ){
      this.query = parseQuery(`http://psudo${req.url}`);
    }
  
    req.deltaSync = {
      pathname,
      params: this.params,
      query: this.query,
    };

    const preReq = await this.runPre(req, socket, head);

    if (!preReq) {
      return log.warn(`Pre runs did not all return true`);
    }
    
    log.debug({params: this.params, query: this.query, headers: this.headers}, `Upgrading request`);
    wss.handleUpgrade(req, socket, head, function done(ws) {
      wss.emit('connection', ws, req);
    });
  }
  attach(server) {
    server.on('upgrade', this.handleUpgrade.bind(this));
  }
}

export default DeltaSync;