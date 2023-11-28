
import path from 'path';
import fs from 'fs/promises';
import { mkdirp } from 'mkdirp';

function getFileName(file){
  return file.webkitRelativePath || file.name;
}


function defaultCallbacks(rootDir, log){
  const callbacks = {
    fileLocation: (req) => {
      const fileName = getFileName(req.file);
      return path.join(rootDir, fileName);
    },
    loadFile: async (req) => {
      const fileName = getFileName(req.file);
      const fileLoc = path.join(rootDir, fileName);
      try {
        return await fs.readFile(fileLoc);
      } catch (error) {
        log.error({error}, `[DeltaSync] Unable to open file`);
        throw error;
      }
    },
    saveFile: async (req, data) => {
      const fileName = getFileName(req.file);
      const fileLoc = path.join(rootDir, fileName);
      const dir = path.dirname(fileLoc);
      try {
        await mkdirp(dir);
        return await fs.writeFile(fileLoc, data);
      } catch (error) {
        log.error({ error }, `[DeltaSync] Unable to write file`);
        throw error;
      }

    },
    onComplete: async (req, data) => {
      return true;
    },
    statFile: async (req) => {
      const fileName = getFileName(req.file);
      const fileLoc = path.join(rootDir, fileName);

      try {
        return await fs.stat(fileLoc);
      } catch (error) {
        if (error.code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    }
  };

  return callbacks;
}


export default defaultCallbacks;