
import { crc32 } from '@node-rs/crc32';
import crypto from 'crypto';
import merge from 'deepmerge';

function createId(){
  const bytes = crypto.randomBytes(256);
  return sha1(bytes);
}

function sha1(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}
function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function hashChunk(chunk) {
  return crc32(chunk);
}


function sum(arr){
  return arr.reduce((a,b) => {
    return a+b;
  }, 0)
}

async function compareHeadTail(file, content){
  const size = file.headTailHash.size;
  const l = file.headTailHash;

  const head = content.slice(0, size);

  const tail = content.slice(content.length - size, content.length);

  const headSum = sha256(head);
  const tailSum = sha256(tail);

  return (headSum === l.head && l.tail === tailSum);
}

function encodeMessage(obj){
  obj['@timestamp'] = new Date();
  obj._id = createId();
  return JSON.stringify(obj);
}

function splitChunksResponse(message) {
  const meta = message.header.chunksMetadata;

  const buffer = message.payload;

  let offset = 0;

  return meta.map(metadata => {
    const end = offset + metadata.size;
    metadata.data = buffer.subarray(offset, end);
    offset += metadata.size;

    const expectedHash = sha1(metadata.data);

    if (metadata.sha1 !== expectedHash) {
      throw new Error(`Buffer does not match expected hash, got ${expectedHash} but was expecting: ${metadata.sha1}`)
    }
    return metadata;
  })
}


class SyncRequest {
  constructor(opts) {
    this.ws = opts.ws;
    this.dir = opts.dir;
    this.log = opts.log;

    this.query = merge({}, opts.query || {});
    this.params = merge({}, opts.params || {});
    this.headers = merge({}, opts.headers || {});
    this.requestObject = merge({}, opts.requestObject || {});
    this.chunkArray = [];
    this.chunksMetadata = {};

    this.callbacks = {
      loadFile: opts.loadFile,
      saveFile: opts.saveFile,
      statFile: opts.statFile,
      onComplete: opts.onComplete,
    }
  }


  async handle(data) {

    const log = this.log;

    const ws = this.ws;
    const self = this;
    const type = data.header?.type;
    const file = data.header?.file;
    const query = self.query;
    const params = self.params;

    if (type === 'fileStatus') {
      log.debug({ file, query, params }, `[DeltaSync] Checking file status`);

      const response = await self.fileStatus(data);
      return ws.send(
        encodeMessage(response)
      );
    }

    if (type === 'fingerprint') {
      log.debug({ file, query, params }, `[DeltaSync] Scanning file for fingerprints`);
      const chunks = await self.compareFingerprint(data);
      log.debug({ file, query, params }, `[DeltaSync] Got the missing chunks`);

      self.chunks = chunks;

      return ws.send(encodeMessage({
        type: 'request-chunks',
        required: chunks.required,
        file,
      }));
    }

    if (type === 'chunks-header'){
      log.debug( `[DeltaSync] Got the chunk header, chunks incomming!`);

      this.chunksMetadata = data.header.chunksMetadata;
      return ;
    }

    if (type === 'fileChunk') {
      const {header, offset, size, index, count} = data.header;      

      const obj = Object.assign({}, data.header);
      obj.data = data.payload;
      self.chunkArray.push(obj);

      if (index !== count){
        return;
      }

      log.debug(`[DeltaSync] Got all chunks, will construct file`);


      data.header.chunksMetadata = self.chunksMetadata; // Apply it before construction

      const constructed = await self.constructFile({
        header: data.header,
        chunks: self.chunkArray,
      });
      
      const payload = constructed.content;
      await self.callbacks.saveFile({
        file,
        params: self.params,
        query: self.query,
        requestObject: self.requestObject,
        headers: self.headers,
      }, payload);

      ws.send(
        encodeMessage({
          file,
          type: 'complete',
          ratio: constructed.ratio,
        })
      );

      return await self.callbacks.onComplete({
        file,
        params: self.params,
        query: self.query,
        requestObject: self.requestObject,
        headers: self.headers,
      }, payload);

    }

    if (type === 'upload') {
      log.debug({ file, query, params }, `[DeltaSync] Got file from client`);
      const payload = data.payload;
      await self.callbacks.saveFile({
        file,
        params: self.params,
        query: self.query,
        requestObject: self.requestObject,
        headers: self.headers,
      }, payload);
      ws.send(
        encodeMessage({
          file,
          type: 'complete',
          ratio: 1,
        }));
      return await self.callbacks.onComplete({
        file,
        params: self.params,
        query: self.query,
        requestObject: self.requestObject,
        headers: self.headers,
      }, payload);
    }
  }

  async fileStatus(message) {
    const self = this;

    const file = message.header.file;
    const stat = await this.callbacks.statFile({
      file,
      params: self.params,
      query: self.query,
    });

    if (! stat ){

      // File does not exist.. Ask for fingerprint and then just request all
      return {
        type: 'fileStatus',
        file,
        exists: false,
        syncRequired: true,
        request: 'fingerprint',
        sha256: '',
      };
    }

    const content = await this.callbacks.loadFile({
      file,
      params: self.params,
      query: self.query,
      requestObject: self.requestObject,
      headers: self.headers,
    });

    const hash = sha256(content);


    if (file.size !== stat.size) {
      return {
        type: 'fileStatus',
        file,
        exists: true,
        syncRequired: true,
        stat,
        request: 'fingerprint',
        sha256: hash,
      };
    }



    if (file.headTailHash){

      const match = await compareHeadTail(file, content);
      if (! match ){
        return {
          type: 'fileStatus',
          file,
          exists: true,
          syncRequired: true,
          stat,
          request: 'fingerprint',
          sha256: hash,
        };
      }
    }

    return {
      type: 'fileStatus',
      file,
      exists: true,
      syncRequired: false,
      stat,
      sha256: hash,
    }
  }

  async constructFile(response) {
    const self = this;
    const file = response.header.file;
    const missingChunks = response.chunks;
    const totalSizeSent = sum(missingChunks.map(chunk => {
      return chunk.data.length;
    }));

    const ratio = (totalSizeSent / file.size);

    let content = Buffer.alloc(0);

    try {
      content = await this.callbacks.loadFile({
        file,
        params: self.params,
        query: self.query,
        requestObject: self.requestObject,
        headers: self.headers,
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        self.log.debug({file}, `[DeltaSync] File does not exist on the server`);
      } else {
        throw error;
      }
    }


    const newFile = Buffer.alloc(file.size);
    this.log.debug({file},`[DeltaSync] New file allocated ${newFile.length}`)
    const chunks = this.chunks.local.concat(missingChunks);
    this.log.debug({file},`[DeltaSync] Got all the chunks, start applying`);


    chunks.forEach((chunk, i) => {
      const offset = chunk.offset;
      const size = chunk.size;
      const end = offset + size;
      if (chunk.exists) {
        const offset = chunk.exists.offset;
        const end = chunk.exists.end;
        chunk.data = content.subarray(offset, end);
      }
      newFile.fill(chunk.data, offset, end);
    });

    const sha256Hash = sha256(newFile);

    if (sha256Hash !== file.sha256) {
      this.log.error({ file }, `File sha256 does not match what was expected, expected: ${file.sha256} but got ${sha256Hash} `)
      throw new Error(`File hash does not match, expected: ${file.sha256} but got ${sha256Hash}`)
    }

    return {
      content: newFile,
      ratio,
    };
  }

  async compareFingerprint(message) {
    const file = message.header.file;
    const self = this;
    const log = this.log;
    let content = Buffer.alloc(0);
    try {
      content = await this.callbacks.loadFile({
        file,
        params: self.params,
        query: self.query,
        requestObject: self.requestObject,
      });
    } catch (error) {
      if (error.code === 'ENOENT'){
        log.debug({file}, `[DeltaSync] File does not exist on the server`);
        return {
          sha256: '',
          required: message.header.fingerprint.hashes,
          local: [],
        }
      } else {
        throw error;
      }
    }

    log.debug({file}, '[DeltaSync] File loaded, scanning for matching chunks');

    const fingerprints = message.header.fingerprint;
    const hashMap = {}
    fingerprints.hashes.forEach(value => {
      hashMap[value.hash] = value;
    });

    const len = content.length;
    const blockSize = fingerprints.blockSize;
    let i = 0;
    let matchedSize = 0;
    const matchingChunks = {};
    const start = new Date();
    let loops = 0;

    function isScanning(i) {
      const matchRatio = (matchedSize / file.size);
      if (matchRatio >= 0.9999){
        return false;
      }

      const matchCount = Object.keys(matchingChunks).length;

      if (matchCount === 0 && loops > blockSize){
        log.info({file}, `[DeltaSync] Already scanned N+1 without no matches ${blockSize}, file has changed to much`);
        return false;
      }
      return (i <= len);
    }

    while (isScanning(i)) {
      const end = i + blockSize;
      let chunk = content.subarray(i, end);
      // Easy low cost CRC32 checksum.
      const hash = hashChunk(chunk);
      const match = hashMap[hash];

      if (match) {
        // If it matches then run stronger sha1 checksum on the chunk
        const sha = sha1(chunk);

        if (sha === match.sha1) {

          // Note where the chunk was matched.
          matchingChunks[sha] = {
            sha1: sha,
            offset: i,
            end,
            size: chunk.length,
          };

          matchedSize = matchedSize + chunk.length; // Calculate how much is matched

          // If found then stop scanning and go to end of doc.
          i = i + match.size;
          chunk = null;
          continue;
        }
      }



      i++;
      loops++;
      chunk = null;
      if (loops % 250 === 0){
        await new Promise(resolve => setImmediate(resolve)); 
      }
    }


    const took = new Date() - start;

    log.debug({file, took}, '[DeltaSync] Completed scanning for files, calulcating chunks');
    const allChunks = fingerprints.hashes.map(value => {
      value.exists = matchingChunks[value.sha1] || false;
      return value;
    });


    return {
      chunks: allChunks,
      sha256: sha256(content),
      required: allChunks.filter(chunk => {
        return !chunk.exists;
      }),
      local: allChunks.filter(chunk => {
        return chunk.exists;
      })
    };
  }
}

export default SyncRequest;