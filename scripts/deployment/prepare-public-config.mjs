import {readFile,mkdir,writeFile,lstat} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import {validateEnvironment} from '../../runtime/environment.ts';
import {readPublicIngress} from '../../runtime/public-ingress.ts';

export function prepareValues(raw,origin,token=randomBytes(32).toString('base64url')){
 const source=parseEnv(raw);
 if(source.LIFEWOOD_ENV!=='production')throw Error('PRODUCTION_CONFIG_REQUIRED');
 if(source.PORT!==undefined&&source.PORT!=='3002')throw Error('PUBLIC_TEMPLATE_REQUIRES_PORT_3002');
 if(source.LIFEWOOD_DESERET_INTEGRATION_ENABLED!==undefined&&!['false','0','true','1'].includes(source.LIFEWOOD_DESERET_INTEGRATION_ENABLED))throw Error('INVALID_INTEGRATION_SWITCH');
 if(['true','1'].includes(source.LIFEWOOD_DESERET_INTEGRATION_ENABLED))throw Error('INITIAL_DEPLOYMENT_REQUIRES_DISABLED_INTEGRATION');
 const values={...source,LIFEWOOD_PUBLIC_ORIGIN:origin,LIFEWOOD_PUBLIC_PROXY_TOKEN:source.LIFEWOOD_PUBLIC_PROXY_TOKEN||token};
 validateEnvironment(values);readPublicIngress(values);
 const cleaned=raw.replace(/^[ \t]*LIFEWOOD_PUBLIC_(?:ORIGIN|PROXY_TOKEN)[ \t]*=.*(?:\r?\n|$)/gm,'');
 return {app:cleaned.replace(/\s*$/,'')+`\nLIFEWOOD_PUBLIC_ORIGIN=${origin}\nLIFEWOOD_PUBLIC_PROXY_TOKEN=${values.LIFEWOOD_PUBLIC_PROXY_TOKEN}\nLIFEWOOD_DESERET_INTEGRATION_ENABLED=false\nLIFEWOOD_DESERET_INTEGRATION_ALLOW_LOOPBACK_HTTP=false\n`,proxy:`proxy_set_header X-Lifewood-Proxy-Token "${values.LIFEWOOD_PUBLIC_PROXY_TOKEN}";\n`};
}
async function main(args){
 if(args.length!==6||args[0]!=='--env'||args[2]!=='--origin'||args[4]!=='--out')throw Error('USAGE');
 const source=resolve(args[1]),output=resolve(args[5]);
 const repository=fileURLToPath(new URL('../../',import.meta.url));const delta=relative(repository,output);
 if(!delta||!delta.startsWith('..')&&!isAbsolute(delta))throw Error('PRIVATE_OUTPUT_OUTSIDE_REPOSITORY_REQUIRED');
 const info=await lstat(source);if(!info.isFile()||info.isSymbolicLink()||process.platform!=='win32'&&(info.mode&0o077))throw Error('PRIVATE_CONFIG_REQUIRED');
 const result=prepareValues(await readFile(source,'utf8'),args[3]);
 await mkdir(output,{mode:0o700});
 await writeFile(join(output,'aigc.env'),result.app,{flag:'wx',mode:0o600});
 await writeFile(join(output,'aigc-proxy-secret.conf'),result.proxy,{flag:'wx',mode:0o600});
 console.log(JSON.stringify({prepared:true,output,sourceUnchanged:true,integrationEnabled:false}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--help'))console.log('node scripts/deployment/prepare-public-config.mjs --env /private/production.env --origin https://www.aigc.lifewood.com --out /private/new-directory\nWrites private config copies only; never installs, restarts or changes resources.');
 else main(process.argv.slice(2)).catch(()=>{console.error('PUBLIC_CONFIG_PREPARATION_FAILED: verify production resource identity, direct transfer, disabled integration, private paths and a new output directory. No source configuration was changed.');process.exitCode=1;});
}
