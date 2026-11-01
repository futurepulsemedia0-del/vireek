// scripts/blog/vite-plugin.mjs
//
// Exposes validated blog content to the app as virtual modules:
//   virtual:vireek-blog              -> { POSTS (metadata only), CATEGORIES, AUTHORS, POST_LOADERS }
//   virtual:vireek-blog/post/<slug>  -> default export: the full post (body AST). Lazy-loaded per article,
//                                       so the index page never ships article bodies.
// Content errors fail `vite build` (and show the overlay in dev), so broken content cannot be deployed.

import path from 'node:path';
import process from 'node:process';
import { loadBlog, postMeta } from './pipeline.mjs';

const INDEX_ID = 'virtual:vireek-blog';
const POST_PREFIX = 'virtual:vireek-blog/post/';
const R = '\0';

export default function vireekBlog() {
  let root = process.cwd();
  let cache;

  const load = () => {
    if (!cache) cache = loadBlog({ root });
    return cache;
  };
  const failIfInvalid = (ctx) => {
    const { errors } = load();
    if (errors.length) ctx.error(`Blog content has ${errors.length} error(s):\n  - ${errors.join('\n  - ')}`);
  };

  return {
    name: 'vireek-blog',
    configResolved(config) {
      root = config.root;
    },
    buildStart() {
      cache = undefined;
      failIfInvalid(this);
    },
    configureServer(s) {
      const dir = path.join(root, 'content', 'blog');
      s.watcher.add(dir);
      const onChange = (file) => {
        if (!file.startsWith(dir)) return;
        cache = undefined;
        for (const id of s.moduleGraph.idToModuleMap.keys()) {
          if (id.startsWith(R + INDEX_ID)) s.moduleGraph.invalidateModule(s.moduleGraph.idToModuleMap.get(id));
        }
        s.ws.send({ type: 'full-reload' });
      };
      s.watcher.on('change', onChange).on('add', onChange).on('unlink', onChange);
    },
    resolveId(id) {
      if (id === INDEX_ID || id.startsWith(POST_PREFIX)) return R + id;
      return null;
    },
    load(id) {
      if (!id.startsWith(R + INDEX_ID)) return null;
      failIfInvalid(this);
      const { posts, categories, authors } = load();
      if (id === R + INDEX_ID) {
        const loaders = posts.map((p) => `  ${JSON.stringify(p.slug)}: () => import(${JSON.stringify(POST_PREFIX + p.slug)}).then((m) => m.default)`);
        return [
          `export const POSTS = ${JSON.stringify(posts.map(postMeta))};`,
          `export const CATEGORIES = ${JSON.stringify(categories)};`,
          `export const AUTHORS = ${JSON.stringify(authors)};`,
          `export const POST_LOADERS = {\n${loaders.join(',\n')}\n};`,
        ].join('\n');
      }
      const post = posts.find((p) => R + POST_PREFIX + p.slug === id);
      if (!post) return 'export default null;';
      return `export default ${JSON.stringify(post)};`;
    },
  };
}
