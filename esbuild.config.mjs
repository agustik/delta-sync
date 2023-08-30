import esbuild from 'esbuild'; 

import fs from 'fs/promises';


try {
  await fs.rmdir('./dist', { recursive: true, force: true });
} catch (error) {
  
}


const clientConfig = {
  entryPoints: [
    'src/client/index.mjs',
  ],
  assetNames: '[dir]/[name]',
  entryNames: '[name]',
  outbase: 'demo',
  outdir: 'dist/client',
  define: {
    'process.env.NODE_ENV': '"production"',
    global: 'window',
  },
  bundle: true,
}


const serverConfig = {
  entryPoints: [
    'src/server/index.mjs',
  ],
  assetNames: '[dir]/[name]',
  entryNames: '[name]',
  format: 'cjs',
  loader: {
    '.node': 'file'
  },
  outdir: 'dist/server',
  platform: 'node',
  target: [
    'node16',
  ],
  bundle: true,
}

await esbuild.build(clientConfig);
await esbuild.build(serverConfig);

await fs.rename('dist/server/index.js', 'dist/server/index.cjs')
await fs.rename('dist/client/index.js', 'dist/client/index.cjs')