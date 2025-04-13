
import crc32 from 'crc/crc32';
import async from 'async';

async function sha1(content) {
  const hashBuffer = await crypto.subtle.digest('SHA-1', content);
  return toHex(hashBuffer);
}

async function sha256(content) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', content);
  return toHex(hashBuffer);
}

function toHex(hashBuffer) {
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const MAX_BLOCKSIZE = 102400;
const KILOBYTE = 1024;

function getBlockSize(fileLength) {

  const n = Math.sqrt(fileLength);
  const m = Math.ceil(n);
  if (m > MAX_BLOCKSIZE) return MAX_BLOCKSIZE;
  return m;
}


function appendBuffers(buffer1, buffer2) {
  var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  tmp.set(new Uint8Array(buffer1), 0);
  tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
  return tmp.buffer;
};

function serializeMessage(header, data){
  const json = JSON.stringify(header);
  const enc = new TextEncoder();
  const encodedHeader = enc.encode(json + '\r\r').buffer;
  if (! data) return encodedHeader;
  return appendBuffers(encodedHeader, data);
}

function parseJson(string) {
  try {
    return JSON.parse(string);
  } catch (error) {
    return false;
  }
}

function hashChunk(chunk) {
  return crc32(chunk);
}

function getProtocol(){
  const proto = self.location.protocol;
  return (proto === 'https:') ? 'wss:' : 'ws:';
}

function getHost() {
  return self.location.host;
}


class DeltaSync {
  constructor(file, opts){
    const proto = getProtocol();
    const host = getHost();
    const url = (/ws?s:\/\//.test(opts.url)) ? opts.url : `${proto}//${host}${opts.url}`;
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.file = file;
    this.bufferSize = 0;
    this.calculateHeadTail = (opts.calculateHeadTail === undefined) ? true : opts.calculateHeadTail;
    this.headTailSize = KILOBYTE * 10; // 10kb
    const getBufferStatus = opts.getBufferStatus || function (){};

    let lastBufferMessageId = false;

    const interval = setInterval(() => {
      const buffered = this.socket.bufferedAmount;
      const total = this.bufferSize;
      const msgId = [buffered, total].join('-');

      if (msgId === lastBufferMessageId ) return;

      getBufferStatus({
        buffered,
        total,
      });

      lastBufferMessageId = msgId;
    }, 50);


    this.notifyUpdates = opts.updates || function (){}

    this.socket.addEventListener('message', async (event) => {
      const message = parseJson(event.data);

      if (!message ) return console.log('Message not json', event);
      if (message.type === 'complete') {
        clearInterval(interval);
        this.emittUpdate('complete', {
          file: this.file,
          message: 'Operation is complete',
          ratio: message.ratio,
          sent: this.bufferSize,
        })
        return this.socket.close();
      }
      if (message.exists === true && message.syncRequired === false){
        clearInterval(interval);
        this.emittUpdate('complete', {
          file: this.file,
          message: 'Operation is complete',
          ratio: 0,
          sent: this.bufferSize,
        })
        return this.socket.close();
      }

      if (message.request === 'fingerprint'){
        await this.sendFingerprint();
      }

      if (message.type === 'fileStatus'){
        if (message.exists === false){
          return;
          return this.sendMissingChunks(message);
          // return this.upload()
        }
      }

      if (message.type === 'request-chunks'){
        return this.sendMissingChunks(message);
      }

      console.log('[DeltaSync] No action required', message);
    })
  }

  emittUpdate(messageType, message) {

    if (typeof message === 'object'){
      message.date = new Date();
    }

    return this.notifyUpdates(messageType, message)
  }

  async sendMissingChunks(message){
    const file = this.file;
    const self = this;
    this.emittUpdate('chunks',{
      file,
      date: new Date(),
      message: 'Sending missing chunks'
    });

    const content = await file.arrayBuffer();

    const count = message.required.length;

    const fileInfo = await this.getFileInfo();

    let i = 1;


    const chunksMetadata = message.required.map(chunk => {
      const { offset, size, sha1 } = chunk;
      return {
        offset, size, sha1
      }
    });


    await self.sendMessage({
      type: 'chunks-header',
      count,
      file: await this.getFileInfo(),
      chunksMetadata,
    });

    await async.forEachSeries(message.required, async function chunkAndTransmit(chunkReq){
      const offset = chunkReq.offset;
      const size = chunkReq.size;
      const end = offset + size;
      const buffer = content.slice(offset, end);

      const header = {
        type: 'fileChunk',
        file: fileInfo,
        count,
        index: i,
        offset,
        size,
        sha1: chunkReq.sha1,
      };

      await self.sendMessage(header, buffer);
      i++;
    })
  }

  async fileStatus(file) {
    this.emittUpdate('fileStatus', {
      file,
      message: 'Checking file status',
    });

    const header = {
      type: 'fileStatus',
      file: await this.getFileInfo(),
    };

    return await this.sendMessage(header, false);
  }

  async getHeadTailHashes(){

    const file = this.file;


    if (this.headTailHash){
      return this.headTailHash;
    }

    const size = this.headTailSize;
    const first4 = file.slice(0, size);
    const last4 = file.slice(file.size - size, file.size);

    this.headTailHash = {
      size,
      head: await sha256(await first4.arrayBuffer()),
      tail: await sha256(await last4.arrayBuffer()),
    }

    return this.headTailHash;
  }

  async getFileInfo(){
    const file = this.file;
    this.emittUpdate('file-info', {
      file,
      message: 'Sending file info',
    });

    return {
      name: file.name,
      size: file.size,
      type: file.type,
      webkitRelativePath: file.webkitRelativePath,
      lastModified: file.lastModified,
      sha256: file.sha256,
      headTailHash: await this.getHeadTailHashes(),
    };
  }

  async sha256file(content){
    this.file.sha256 = await sha256(content)

    return this.file.sha256;
  }

  async sendMessage(header, content){
    const message = serializeMessage(header, content);
    this.bufferSize += message.byteLength;
    
    if (this.socket.readyState !== 1 && ! this.disconnected ){
      console.error('[DeltaSync] Server disconnected', this.socket); 
      this.disconnected = true;
      this.emittUpdate('error', {
        file: this.file,
        date: new Date(),
        message: 'Socket disconnected',
      });
      return;
    }
    return this.socket.send(message);
  }

  async sync() {
    if (this.socket.readyState === 1){
      await this.fileStatus(this.file);
    }

    this.socket.addEventListener('open', async (event) => {
      await this.fileStatus(this.file);
    })


    return new Promise((resolve, reject) => {
      this.socket.addEventListener('close', (event) => {
        return resolve(event);
      });

      this.socket.addEventListener('error', (event) => {
        return reject(event);
      });

    })
  }
  async sendFingerprint(){
    const file = this.file;

    this.emittUpdate('fingerprint', {
      file,
      date: new Date(),
      message: 'Calculating file fingerprint',
    });

    const fingerprint = await this.getFingerprint(file);
    const header = {
      type: 'fingerprint',
      file: await this.getFileInfo(),
      fingerprint,
    };

    await this.sendMessage(header, false);

    this.emittUpdate('fingerprint', {
      file,
      message: 'Fingerprint sent',
      fingerprint,
    });

  }

  async getFingerprint(file) {
    const content = await file.arrayBuffer();
    const hash = await this.sha256file(content);

    const len = content.byteLength;

    const blockSize = getBlockSize(len);
    const hashes = [];

    for (let i = 0; i <= len; i = i + blockSize) {

      const offset = i;
      const end = i + blockSize;

      const chunk = content.slice(i, end)

      const hash = hashChunk(chunk);
      const sha1Hash = await sha1(chunk);
      hashes.push({
        hash,
        sha1: sha1Hash,
        offset,
        size: chunk.byteLength,
      });
    }

    return {
      hashes,
      blockSize,
      sha256: hash,
      size: len,
    }
  }

}

export default DeltaSync;