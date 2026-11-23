import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {S3Client} from '@aws-sdk/client-s3';
import {loadConfig,createWorker,createExecutor} from './worker.mjs';
const fail=code=>new Error(code);
{
  try {
    const env=parseEnv(readFileSync(process.env.DESERET_RELAY_ENV_FILE,'utf8')),config=loadConfig(env);
    const port=Number(env.DESERET_RELAY_PORT || '5390');if(!Number.isInteger(port)||port<1024||port>65535)throw fail('INVALID_PORT');
    const client=new S3Client({region:config.region,endpoint:config.endpoint,forcePathStyle:true,credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},requestChecksumCalculation:"WHEN_REQUIRED",maxAttempts:1,requestHandler:{connectionTimeout:10000,socketTimeout:110000}});
    const server=createWorker(config,createExecutor(config,client));server.requestTimeout=120000;server.headersTimeout=10000;
    server.listen(port,'127.0.0.1',()=>console.log('Deseret transfer worker listening on loopback.'));
    const stop=()=>server.close(()=>{client.destroy();process.exit(0);});process.on('SIGTERM',stop);process.on('SIGINT',stop);
  }catch {console.error('Deseret transfer worker configuration is invalid.');process.exitCode=1;}
}
