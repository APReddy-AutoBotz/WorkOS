import path from 'node:path';
import {readFile} from 'node:fs/promises';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import {loadFrontendEnvironment, publicFrontendEnvironment} from './frontend-environment.mjs';

export default {
  name: 'workos-development-assets',
  setup(builder) {
    const root = process.cwd();
    builder.onLoad({filter: /[\\/]frontendEnvironment\.ts$/}, async () => {
      const mode = process.env.WORKOS_FRONTEND_MODE || 'development';
      const environment = await loadFrontendEnvironment(root, mode);
      return {loader: 'js', contents: 'export const frontendEnv = ' +
        JSON.stringify(publicFrontendEnvironment(environment, mode, false))};
    });
    builder.onLoad({filter: /[\\/]src[\\/]index\.css$/}, async ({path: file}) => {
      const css = await postcss([tailwind({base: root})]).process(await readFile(file, 'utf8'), {from: file});
      return {loader: 'css', contents: css.css};
    });
  },
};
