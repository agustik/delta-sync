
import crc32 from 'crc/crc32';

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

class DeltaSync {
  constructor(file, opts){
    const self = this;

    const proto = (window.location.protocol === 'https:') ? 'wss:' : 'ws:'
    const url = (/ws?s:\/\//.test(opts.url)) ? opts.url : `${proto}//${window.location.host}${opts.url}`;
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.file = file;
    this.bufferSize = 0;
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
        await self.sendFingerprint();
      }

      if (message.type === 'fileStatus'){
        if (message.exists === false){
          return self.upload()
        }
      }

      if (message.type === 'request-chunks'){
        return self.sendMissingChunks(message);
      }
    })
  }

  emittUpdate(messageType, message) {

    if (typeof message === 'object'){
      message.date = new Date();
    }

    return this.notifyUpdates(messageType, message)
  }

  async sendMissingChunks(message){
    const self = this;
    const file = this.file;
    this.emittUpdate('chunks',{
      file,
      date: new Date(),
      message: 'Sending missing chunks'
    });
    const content = await file.arrayBuffer();
    const chunks = message.required.map(chunkReq => {
      const offset = chunkReq.offset;
      const size = chunkReq.size;
      const end = offset + size;
      const data = content.slice(offset, end);
      
      return {
        offset,
        size,
        data,
        sha1: chunkReq.sha1,
      };
    });


    const chunkMetadata = chunks.map(chunk => {
      const { offset, size, sha1 } = chunk;
      return {
        offset, size, sha1
      }
    });

    const header = {
      type: 'fileChunks',
      file: self.getFileInfo(),
      chunkMetadata,
    };

    let buffer = new ArrayBuffer(0);
    chunks.map(chunk => {
      buffer = appendBuffers(buffer, chunk.data);
    });

    // const payload = new ArrayBuffer(totalSize);
    await this.sendMessage(header, buffer);
    this.emittUpdate('chunks',{
      file,
      message: 'Done sending chunks',
      size: buffer.byteLength,
      count: chunks.length,
    });
  }

  async fileStatus(file) {
    this.emittUpdate('fileStatus', {
      file,
      message: 'Checking file status',
    });

    const header = {
      type: 'fileStatus',
      file: this.getFileInfo(),
    };

    return await this.sendMessage(header, false);
  }

  getFileInfo(){
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
    };
  }


  async upload(){

    const file = this.file;
    this.emittUpdate('upload', {
      file,
      date: new Date(),
      message: 'Uploading file',
    });
    const content = await file.arrayBuffer();
    const hash = await this.sha256file(content);
    const header = {
      type: 'upload',
      file: this.getFileInfo(),
      sha256: hash,
    };

    await this.sendMessage(header, content);

    this.emittUpdate('upload', {
      file,
      message: 'Upload complete',
    });
  }

  async sha256file(content){
    this.file.sha256 = await sha256(content)

    return this.file.sha256;
  }

  async sendMessage(header, content){
    const message = serializeMessage(header, content);
    this.bufferSize += message.byteLength;
    return this.socket.send(message);
  }

  async sync() {

    const self = this;
    if (this.socket.readyState === 1){
      await this.fileStatus(this.file);
    }

    this.socket.addEventListener('open', async (event) => {
      await this.fileStatus(this.file);
    })


    return new Promise((resolve, reject) => {
      self.socket.addEventListener('close', (event) => {
        return resolve(event);
      });

      self.socket.addEventListener('error', (event) => {
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
      file: this.getFileInfo(),
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