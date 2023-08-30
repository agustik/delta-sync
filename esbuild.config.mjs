import esbuild from 'esbuild'; 

import fs from 'fs/promises';


try {
  await fs.rmdir('./dist', { recursive: true, force: true });
  await fs.rmdir('./client', { recursive: true, force: true });
} catch (error) {
  
}


const clientConfig = {
  entryPoints: [
    'src/client/index.mjs',
  ],
  assetNames: '[dir]/[name]',
  entryNames: '[name]',
  outbase: 'demo',
  outdir: 'client',
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

await fs.rename('client/index.js', 'client/index.cjs')


await fs.writeFile('dist/server/package.json', JSON.stringify({
  type: 'commonjs',
}, null, 2))