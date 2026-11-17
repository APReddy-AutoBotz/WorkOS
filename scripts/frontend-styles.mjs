import path from 'node:path';
import {readFile} from 'node:fs/promises';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

export const frontendStyles = root => ({
  name: 'workos-tailwind',
  setup(builder) {
    builder.onLoad({filter: /\.css$/}, async ({path: file}) => {
      const css = await postcss([tailwind({base: root})]).process(await readFile(file, 'utf8'), {from: file});
      return {contents: css.css, loader: 'css', resolveDir: path.dirname(file)};
    });
  },
});
