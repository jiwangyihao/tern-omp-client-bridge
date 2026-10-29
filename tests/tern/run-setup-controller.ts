// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const executable=process.argv[2];
if(!executable) throw Error('Usage: bun tests/tern/run-setup-controller.ts /path/to/luau');
const dir=await mkdtemp(join(tmpdir(),'bridge-setup-controller-'));
try {
 for(const file of ['setup-controller.luau','setup-target.luau']) await writeFile(join(dir,file),await readFile(new URL('../../tern/'+file,import.meta.url),'utf8'));
 const harness=await readFile(new URL('./setup-controller-harness.luau',import.meta.url),'utf8');
 const runner=join(dir,'run.luau');
 await writeFile(runner,harness+'\nrun(require("./setup-controller"))\n');
 const child=Bun.spawn([executable,runner],{stdout:'inherit',stderr:'inherit'});
 if(await child.exited!==0)throw Error('Shipped setup coordinator regression failed');
}finally{await rm(dir,{recursive:true,force:true})}
