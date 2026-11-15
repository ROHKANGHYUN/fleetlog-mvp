import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
const root=fileURLToPath(new URL('../',import.meta.url));
if(Number(process.versions.node.split('.')[0])!==24)throw Error('Node.js 24 LTS를 설치하세요.');
const vite=resolve(root,'node_modules/vite/bin/vite.js');
if(!existsSync(vite))throw Error('프로젝트 루트에서 npm ci를 먼저 실행하세요.');
// Keep ports fixed across the development proxy, CORS checks and Android sample.
const env={...process.env,HOST:'127.0.0.1',PORT:'4000'};
const children=[
  spawn(process.execPath,['services/api/src/server.mjs'],{cwd:root,env,stdio:'inherit'}),
  spawn(process.execPath,[vite,'--host','127.0.0.1'],{cwd:resolve(root,'apps/web'),env,stdio:'inherit'}),
];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;process.exitCode=code;for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');}
for(const child of children){child.on('error',error=>{console.error(error.message);stop(1);});child.on('exit',(code)=>{if(!stopping)stop(code??1);});}
process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());
console.log('웹: http://127.0.0.1:5173 · API: http://127.0.0.1:4000 · 종료: Ctrl+C');
