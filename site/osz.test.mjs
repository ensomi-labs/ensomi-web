import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { strFromU8, unzipSync } from 'fflate';

const { bundle, chartFile, safeName, shortHash, withoutKeys } = await import('./osz.ts');
// The runtime's own archive, which the downloads replace; its package exports only the generator API.
const { exportOsz } = await import('../node_modules/@ensomi/runtime/src/export.js');

/** A `.osu` laid out as the runtime writes it (ensomi-runtime crates/generate/src/export.rs). */
function runtimeOsu({ title = 'Night Shift', artist = 'Artist', seed = 1, first = 1000, audio = 'audio.mp3' } = {}) {
    return `osu file format v14
[General]
AudioFilename:${audio}
Mode:3
[Metadata]
Title:${title}
Artist:${artist}
Creator:Ensomi
Version:Ensomi r2 s${seed}
BeatmapID:0
BeatmapSetID:-1
[Difficulty]
CircleSize:4
[TimingPoints]
2,500.0,4,2,0,100,1,0
// ensomi-runtime 0.3.2 seed=${seed} random=mulberry32-u53-v1
[HitObjects]
64,192,${first},1,0,0:0:0:0:
192,192,${first + 500},128,0,${first + 900}:0:0:0:0:
`;
}
/** A receipt laid out as the runtime writes it; two runs of one generation differ in `seconds` and `wall_seconds`. */
function runtimeReceipt({ seed = 1, seconds = 1.5 } = {}) {
    return `{
  "runtime": {
    "name": "ensomi-runtime",
    "version": "0.3.2"
  },
  "seed": ${seed},
  "metadata": {
    "title": "Night Shift",
    "artist": "Artist"
  },
  "controls": {
    "difficulty": {
      "passes": [
        {
          "multiplier": 0.844651725950986,
          "fallback_count": 0,
          "wall_seconds": ${seconds}
        }
      ]
    }
  },
  "export": {
    "replay_finalized": true
  },
  "seconds": {
    "rows": ${seconds / 3},
    "total": ${seconds}
  }
}`;
}
const TIMINGS = new Set(['seconds', 'wall_seconds']);
const chart = { title: 'Night Shift', artist: 'Artist', seed: 1 }, song = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]), audioId = await shortHash(song);
const make = (options = {}) => chartFile(runtimeOsu(options), runtimeReceipt(options), audioId, { ...chart, seed: options.seed ?? 1 });
const files = async (charts, audio = song) => unzipSync((await bundle(charts, audio)).osz);

/** What osu!lazer identifies an import by: SHA-256 over its `.osu` files, by name (BeatmapImporter's HashableFileTypes). */
function setHash(archive) {
    const hash = createHash('sha256');
    for (const name of Object.keys(archive).filter(n => n.endsWith('.osu')).sort()) hash.update(archive[name]);
    return hash.digest('hex');
}
const distinct = values => assert.equal(new Set(values).size, values.length, values.join('\n'));

test('takes IDs from the first eight hexadecimal digits of SHA-256', async () => {
    assert.equal(await shortHash('abc'), createHash('sha256').update('abc').digest('hex').slice(0, 8));
    assert.equal(audioId, createHash('sha256').update(song).digest('hex').slice(0, 8));
});

test('packs one chart with the unchanged song and its receipt without timings, named by their content', async () => {
    const c = await make(), { name, osz } = await bundle([c], song), archive = unzipSync(osz);
    assert.deepEqual(Object.keys(archive), [`audio-${audioId}.mp3`, `Night Shift-s1-${c.id}.osu`, `receipt-${c.id}.json`]);
    assert.deepEqual(archive[`audio-${audioId}.mp3`], song);
    assert.equal(strFromU8(archive[c.osuName]), c.osu);
    assert.equal(name, `Artist - Night Shift (ensomi R2 s1 ${c.id})`);
    const receipt = JSON.parse(strFromU8(archive[c.receiptName])), [pass] = receipt.controls.difficulty.passes;
    assert.equal(receipt.seconds, undefined);
    assert.deepEqual(pass, { multiplier: 0.844651725950986, fallback_count: 0 });
});

test('changes only the audio file and the difficulty name of the runtime\'s .osu, and holds what its .osz holds', async () => {
    const source = runtimeOsu({ audio: 'audio.ogg' }), c = await chartFile(source, runtimeReceipt(), audioId, chart);
    const runtime = unzipSync(exportOsz(source, { name: 'Song.OGG', bytes: song }, runtimeReceipt())), ours = await files([c]);
    assert.deepEqual(Object.keys(runtime), ['generated.osu', 'audio.ogg', 'receipt.json']);
    assert.deepEqual(ours[`audio-${audioId}.ogg`], runtime['audio.ogg']);
    const before = strFromU8(runtime['generated.osu']).split('\n'), after = strFromU8(ours[c.osuName]).split('\n');
    assert.equal(after.length, before.length);
    assert.deepEqual(after.filter((line, i) => line !== before[i]), [`AudioFilename:audio-${audioId}.ogg`, `Version:Ensomi r2 s1 #${c.id}`]);
    const receipt = JSON.parse(strFromU8(runtime['receipt.json']));
    delete receipt.seconds;
    delete receipt.controls.difficulty.passes[0].wall_seconds;
    assert.deepEqual(JSON.parse(strFromU8(ours[c.receiptName])), receipt);
});

test('exports the same chart again as the same files, which osu!lazer reuses instead of replacing', async () => {
    const again = [await make({ seconds: 1.5 }), await make({ seconds: 2.5 })], archives = await Promise.all(again.map(c => files([c])));
    assert.deepEqual(Object.keys(archives[1]), Object.keys(archives[0]));
    assert.deepEqual(archives[1], archives[0]);
    assert.equal((await bundle([again[1]], song)).name, (await bundle([again[0]], song)).name);
    // The runtime's archives of the two runs share the set hash but not the receipt, so the second replaced the first.
    const runtime = [1.5, 2.5].map(seconds => unzipSync(exportOsz(runtimeOsu(), { name: 'song.mp3', bytes: song }, runtimeReceipt({ seconds }))));
    assert.equal(setHash(runtime[1]), setHash(runtime[0]));
    assert.notDeepEqual(runtime[1]['receipt.json'], runtime[0]['receipt.json']);
});

test('names a chart by its song and notes, not by its title or artist', async () => {
    const base = await make(), renamed = await chartFile(runtimeOsu({ title: 'Other', artist: 'Someone' }), runtimeReceipt(), audioId, { title: 'Other', artist: 'Someone', seed: 1 });
    assert.equal(renamed.id, base.id);
    assert.match(renamed.osu, new RegExp(`^Version:Ensomi r2 s1 #${base.id}$`, 'm'));
    const otherSong = await chartFile(runtimeOsu(), runtimeReceipt(), await shortHash(new Uint8Array([9])), chart);
    distinct([base, await make({ first: 2000 }), await make({ seed: 2 }), otherSong].map(c => c.id));
});

test('keeps other charts apart: other songs, one title for two songs, other seeds', async () => {
    const songs = [song, new Uint8Array([1]), new Uint8Array([2])];
    const runs = [{ title: 'Night Shift', first: 1000, of: 0 }, { title: 'Morning', first: 2000, of: 1 }, { title: 'Night Shift', first: 3000, of: 2 }, { title: 'Night Shift', first: 1500, seed: 2, of: 0 }];
    const made = await Promise.all(runs.map(async ({ title, first, seed = 1, of }) => {
        const c = await chartFile(runtimeOsu({ title, seed, first }), runtimeReceipt({ seed }), await shortHash(songs[of]), { title, artist: 'Artist', seed });
        return { c, archive: await files([c], songs[of]), name: (await bundle([c], songs[of])).name };
    }));
    distinct(made.map(m => setHash(m.archive)));
    distinct(made.map(m => m.name));
    distinct(made.map(m => m.c.osuName));
    // One song's charts share its audio file, the same bytes under the same name; other songs have their own.
    assert.equal(made[3].c.audioName, made[0].c.audioName);
    distinct(made.slice(0, 3).map(m => m.c.audioName));
});

test('bundles staged charts of one song into one .osz with the song once', async () => {
    const charts = [await make(), await make({ seed: 2, first: 1500 }), await make({ seed: 3, first: 1700 })];
    const { name, osz } = await bundle(charts, song), archive = unzipSync(osz);
    assert.deepEqual(Object.keys(archive), [`audio-${audioId}.mp3`, ...charts.flatMap(c => [c.osuName, c.receiptName])]);
    for (const c of charts) assert.match(strFromU8(archive[c.osuName]), new RegExp(`^AudioFilename:audio-${audioId}\\.mp3$`, 'm'));
    assert.equal(name, `Artist - Night Shift (ensomi R2 ×3 ${await shortHash(charts.map(c => c.id).sort().join(' '))})`);
    assert.equal((await bundle([...charts].reverse(), song)).name, name);
    await assert.rejects(bundle([], song), /one song/);
    await assert.rejects(bundle([charts[0], await chartFile(runtimeOsu(), runtimeReceipt(), await shortHash(new Uint8Array([9])), chart)], song), /one song/);
});

test('leaves out the receipt\'s timings, keeping every other value\'s digits and layout', () => {
    const receipt = runtimeReceipt({ seed: '18446744073709551615' }), out = withoutKeys(receipt, TIMINGS);
    assert.match(out, /"seed": 18446744073709551615,/);
    assert.doesNotMatch(out, /seconds/);
    assert.equal(withoutKeys(receipt, new Set()), receipt);
    assert.equal(withoutKeys('{\n  "a": 1,\n  "seconds": {\n    "t": 2\n  }\n}', TIMINGS), '{\n  "a": 1\n}');
    assert.equal(withoutKeys('{"a":[1,{"seconds":2,"b":"x\\"seconds\\":3"}],"seconds":{"t":1}}', TIMINGS), '{"a":[1,{"b":"x\\"seconds\\":3"}]}');
    assert.equal(withoutKeys('{"seconds":1}', TIMINGS), '{}');
    assert.throws(() => withoutKeys('{"a": [1, 2}', TIMINGS), SyntaxError);
});

test('names files safely on Windows, macOS and Linux', () => {
    assert.equal(safeName('../..\\etc/passwd', 40), 'etc passwd');
    assert.equal(safeName('Title: "Sub" <x>?*|', 40), 'Title Sub x');
    assert.equal(safeName('a\u0000b\nc\td\u007fe', 40), 'a b c d e');
    assert.equal(safeName('  ..hidden..  ', 40), 'hidden');
    assert.equal(safeName('...', 40), 'untitled');
    assert.equal(safeName('', 40), 'untitled');
    assert.equal(safeName('夜に駆ける', 40), '夜に駆ける');
    assert.equal(safeName('🎵'.repeat(50), 40), '🎵'.repeat(40));
    assert.equal(safeName('a'.repeat(39) + ' b', 40), 'a'.repeat(39));
});

test('keeps the seed and chart ID in the names of a long title', async () => {
    const title = 'x'.repeat(200), seed = 18446744073709551615n;
    const c = await chartFile(runtimeOsu({ title, seed }), runtimeReceipt({ seed }), audioId, { title, artist: '', seed });
    assert.equal(c.osuName, `${'x'.repeat(40)}-s18446744073709551615-${c.id}.osu`);
    assert.equal((await bundle([c], song)).name, `${'x'.repeat(80)} (ensomi R2 s18446744073709551615 ${c.id})`);
    const slash = await chartFile(runtimeOsu(), runtimeReceipt(), audioId, { ...chart, title: 'AC/DC', artist: '' });
    assert.equal((await bundle([slash], song)).name, `AC DC (ensomi R2 s1 ${slash.id})`);
});

test('refuses a .osu without Version or AudioFilename', async () => {
    await assert.rejects(chartFile(runtimeOsu().replace(/^Version:.*\n/m, ''), runtimeReceipt(), audioId, chart), /missing/);
    await assert.rejects(chartFile(runtimeOsu({ audio: 'audio' }), runtimeReceipt(), audioId, chart), /missing/);
});
