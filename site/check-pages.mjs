// Checks each translated page against its English one: the same element ids in the same order (app.ts looks them
// up on the home page, and each page's section links point to them), and on the home page the statement and its
// Japanese line unchanged.   node site/check-pages.mjs
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const ids = html => [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const statement = html => [/<h1[^>]*>([\s\S]*?)<\/h1>/, /<p class="jp" lang="ja">([\s\S]*?)<\/p>/].map(re => html.match(re)?.[1]);

let failed = false;
for (const [english, hasStatement] of [['index.html', true], ['data-provenance/index.html', false]]) {
    const en = read(english);
    for (const path of [`ja/${english}`, `zh/${english}`]) {
        const page = read(path), problems = [];
        if (ids(page).join() !== ids(en).join()) problems.push(`ids differ from ${english}: ${ids(page).filter((id, i) => id !== ids(en)[i]).slice(0, 5).join(', ')}`);
        if (hasStatement && statement(page).join() !== statement(en).join()) problems.push(`the statement or its Japanese line differs from ${english}`);
        console.log(problems.length ? `${path}: ${problems.join('; ')}` : `${path}: ok`);
        failed ||= problems.length > 0;
    }
}
process.exitCode = failed ? 1 : 0;
