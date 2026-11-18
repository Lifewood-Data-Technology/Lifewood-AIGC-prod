import vinext from 'vinext';
import {defineConfig} from 'vite';

// One Node build for local development and private deployment.
export default defineConfig({
 environments:{client:{build:{outDir:'dist-mysql/client'}}},
 plugins:[vinext({rscOutDir:'dist-mysql/server',ssrOutDir:'dist-mysql/ssr',clientOutDir:'dist-mysql/client'})],
});
