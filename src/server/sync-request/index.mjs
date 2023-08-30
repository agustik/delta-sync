
import { crc32 } from '@node-rs/crc32';
import crypto from 'crypto';

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

function encodeMessage(obj){

  obj['@timestamp'] = new Date();
  obj._id = createId();
  return JSON.stringify(obj);
}

function splitChunksResponse(message) {
  const meta = message.header.chunkMetadata;

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

    this.query = opts.query;
    this.params = opts.params;

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
      log.debug({ file, query, params }, `Checking file status`);

      const response = await self.fileStatus(data);
      return ws.send(
        encodeMessage(response)
      );
    }

    if (type === 'fingerprint') {
      log.debug({ file, query, params }, `Scanning file for fingerprints`);
      const chunks = await self.compareFingerprint(data);

      self.chunks = chunks;

      return ws.send(encodeMessage({
        type: 'request-chunks',
        required: chunks.required,
        file,
      }));
    }

    if (type === 'fileChunks') {
      log.debug({ file, query, params }, `Constructing file from remote chunks`);
      const constructed = await self.constructFile(data);
      const payload = constructed.content;
      await self.callbacks.saveFile({
        file,
        params: self.params,
        query: self.query,
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
      }, payload);

    }

    if (type === 'upload') {
      log.debug({ file, query, params }, `Got file from client`);
      const payload = data.payload;
      await self.callbacks.saveFile({
        file,
        params: self.params,
        query: self.query,
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
      return {
        type: 'fileStatus',
        exists: false,
        file,
      };
    }

    const content = await this.callbacks.loadFile({
      file,
      params: self.params,
      query: self.query,
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
    const content = await this.callbacks.loadFile({
      file,
      params: self.params,
      query: self.query,
    });
    const newFile = Buffer.alloc(file.size);
    const missingChunks = splitChunksResponse(response);
    const chunks = this.chunks.local.concat(missingChunks);


    chunks.forEach(chunk => {

      const offset = chunk.offset;
      const size = chunk.size;
      const end = offset + size;

      if (chunk.exists) {
        const offset = chunk.exists.offset;
        const end = chunk.exists.end;
        chunk.data = content.subarray(offset, end);
      }

      newFile.fill(chunk.data, offset, end);
    })

    const sha256Hash = sha256(newFile);

    if (sha256Hash !== file.sha256) {
      throw new Error(`File hash does not match, expected :${file.sha256} but got ${sha256Hash}`)
    }

    return {
      content: newFile,
      ratio: (file.size / response.payload.length),
    };
  }

  async compareFingerprint(message) {
    const file = message.header.file;
    const self = this;
    const content = await this.callbacks.loadFile({
      file,
      params: self.params,
      query: self.query,
    });
    const fingerprints = message.header.fingerprint;
    const hashMap = {}
    fingerprints.hashes.forEach(value => {
      hashMap[value.hash] = value;
    });

    const len = content.length;
    const blockSize = fingerprints.blockSize;
    function isScanning(i) {
      return (i <= len);
    }
    const matchingChunks = {}
    let i = 0;

    while (isScanning(i)) {
      const end = i + blockSize;
      const chunk = content.subarray(i, end);

      // Easy low cost CRC32 checksum.
      const hash = hashChunk(chunk);
      const match = hashMap[hash];


      if (match) {
        // If it matches then run stronger sha1 checksum on the chunk
        const sha = sha1(chunk);

        if (sha === match.sha1) {

          // console.log('Got match', sha);
          // Note where the chunk was matched.
          matchingChunks[sha] = {
            sha1: sha,
            offset: i,
            end,
            size: chunk.length
          };

          // If found then stop scanning and go to end of doc.
          i = i + match.size;
          continue;
        }
      }
      i++;
    }
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