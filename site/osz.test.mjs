import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { strFromU8, unzipSync } from 'fflate';

const { chartDownloads, exportId, safeName } = await import('./osz.ts');
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
const chart = { title: 'Night Shift', artist: 'Artist', seed: 1 };
// Receipts of two runs of one generation differ in their timings.
const receipt = (seconds = 1.5) => JSON.stringify({ seed: 1, seconds: { total: seconds } });

/** What osu!lazer identifies an import by: SHA-256 over its `.osu` files, by name (BeatmapImporter's HashableFileTypes). */
function setHash(files) {
    const hash = createHash('sha256');
    for (const name of Object.keys(files).filter(n => n.endsWith('.osu')).sort()) hash.update(files[name]);
    return hash.digest('hex');
}

test('packs the chart and the unchanged song under names with the export ID, beside the receipt', () => {
    const song = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
    const { name, osu, osz } = chartDownloads(runtimeOsu(), receipt(), song, chart, '0123abcd');
    const files = unzipSync(osz);
    assert.deepEqual(Object.keys(files), ['Night Shift-s1-0123abcd.osu', 'audio-0123abcd.mp3', 'receipt.json']);
    assert.equal(strFromU8(files['Night Shift-s1-0123abcd.osu']), osu);
    assert.deepEqual(files['audio-0123abcd.mp3'], song);
    assert.equal(strFromU8(files['receipt.json']), receipt() + '\n');
    assert.equal(name, 'Artist - Night Shift (ensomi R2 s1 0123abcd)');
});

test('changes only the audio file and the difficulty name of the runtime\'s .osu and its .osz', () => {
    const song = new Uint8Array([1, 2, 3, 4]), source = runtimeOsu({ audio: 'audio.ogg' });
    const runtime = unzipSync(exportOsz(source, { name: 'Song.OGG', bytes: song }, receipt()));
    const ours = unzipSync(chartDownloads(source, receipt(), song, chart, '0123abcd').osz);
    assert.deepEqual(Object.keys(runtime), ['generated.osu', 'audio.ogg', 'receipt.json']);
    assert.deepEqual(Object.keys(ours), ['Night Shift-s1-0123abcd.osu', 'audio-0123abcd.ogg', 'receipt.json']);
    assert.deepEqual(ours['audio-0123abcd.ogg'], runtime['audio.ogg']);
    assert.deepEqual(ours['receipt.json'], runtime['receipt.json']);
    const before = strFromU8(runtime['generated.osu']).split('\n'), after = strFromU8(ours['Night Shift-s1-0123abcd.osu']).split('\n');
    assert.equal(after.length, before.length);
    assert.deepEqual(after.filter((line, i) => line !== before[i]), ['AudioFilename:audio-0123abcd.ogg', 'Version:Ensomi r2 s1 #0123abcd']);
});

test('keeps exports apart: other songs, one title for two songs, other seeds and the same seed again', () => {
    const runs = [
        { title: 'Night Shift', first: 1000 },
        { title: 'Morning', first: 2000 },
        { title: 'Night Shift', first: 3000 },
        { title: 'Night Shift', first: 1000, seed: 2 },
        // The same song, seed and conditions: the runtime gives the same .osu and a receipt with other timings.
        { title: 'Night Shift', first: 1000, seconds: 2.5 },
        { title: 'Night Shift', first: 1000 },
    ];
    const made = runs.map(({ title, first, seed = 1, seconds }, i) => {
        const source = runtimeOsu({ title, seed, first }), song = new Uint8Array([i]);
        const download = chartDownloads(source, receipt(seconds), song, { title, artist: 'Artist', seed });
        return { download, files: unzipSync(download.osz), runtime: unzipSync(exportOsz(source, { name: 'song.mp3', bytes: song }, receipt(seconds))) };
    });
    // osu!lazer deletes an earlier set with the same set hash but other files: the runtime's archive of the same seed again.
    assert.equal(setHash(made[4].runtime), setHash(made[0].runtime));
    assert.notDeepEqual(made[4].runtime['receipt.json'], made[0].runtime['receipt.json']);

    const distinct = values => assert.equal(new Set(values).size, values.length, values.join('\n'));
    distinct(made.map(m => setHash(m.files)));
    distinct(made.map(m => m.download.name));
    distinct(made.map(m => /^Version:.*$/m.exec(m.download.osu)[0]));
    // Two archives extracted into one folder overwrite no chart or song of the other.
    distinct(made.flatMap(m => Object.keys(m.files).filter(n => n !== 'receipt.json')));
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

test('keeps the seed and export ID in the names of a long title', () => {
    const title = 'x'.repeat(200), seed = 18446744073709551615n;
    const { name, osz } = chartDownloads(runtimeOsu({ title, seed }), receipt(), new Uint8Array(1), { title, artist: '', seed }, '0123abcd');
    assert.equal(name, `${'x'.repeat(80)} (ensomi R2 s18446744073709551615 0123abcd)`);
    assert.deepEqual(Object.keys(unzipSync(osz)), [`${'x'.repeat(40)}-s18446744073709551615-0123abcd.osu`, 'audio-0123abcd.mp3', 'receipt.json']);
    assert.equal(chartDownloads(runtimeOsu(), receipt(), new Uint8Array(1), { ...chart, title: 'AC/DC', artist: '' }, '0123abcd').name, 'AC DC (ensomi R2 s1 0123abcd)');
});

test('refuses an export ID that is not eight lowercase hexadecimal digits, and a .osu without Version or AudioFilename', () => {
    for (const id of ['0123ABCD', '0123abc', 'not-an-id', '01234567-89ab-cdef-0123-456789abcdef'])
        assert.throws(() => chartDownloads(runtimeOsu(), receipt(), new Uint8Array(1), chart, id), /Export ID/);
    assert.throws(() => chartDownloads(runtimeOsu().replace(/^Version:.*\n/m, ''), receipt(), new Uint8Array(1), chart), /missing/);
    assert.throws(() => chartDownloads(runtimeOsu({ audio: 'audio' }), receipt(), new Uint8Array(1), chart), /missing/);
});

test('draws export IDs of eight hexadecimal digits', () => {
    const ids = Array.from({ length: 20 }, exportId);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}$/);
    assert.ok(new Set(ids).size > 1);
});
