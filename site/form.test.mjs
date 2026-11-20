import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlStatus } from '@ensomi/runtime';

const { activeSectionControls, songMetadata, syncCapabilities } = await import('./form.ts');

test('replaces previous song metadata when importing a new song (issue #33)', () => {
    // Choosing a song clears the inputs first (`typed` is empty unless edited during decode):
    // 1. Untagged file uses its own stem and clears any previous artist.
    assert.deepEqual(songMetadata('second-track.ogg'), { title: 'second-track', artist: '' });

    // 2. Tagged file uses its embedded Title and Artist tags.
    assert.deepEqual(songMetadata('01 - file.flac', { title: '  Catch the Moment ', artist: ' LiSA ' }), {
        title: 'Catch the Moment',
        artist: 'LiSA',
    });

    // 3. Whitespace-only tags fall back to the file stem and blank artist.
    assert.deepEqual(songMetadata('track.v2.m4a', { title: '   ', artist: '\n' }), {
        title: 'track.v2',
        artist: '',
    });

    // 4. Text typed while the new song is still decoding is preserved.
    assert.deepEqual(songMetadata('track.mp3', { title: 'Tagged', artist: 'Someone' }, { title: 'Custom Title', artist: '' }), {
        title: 'Custom Title',
        artist: 'Someone',
    });
});

test('clamps star slider and filters sections when a model loads or reloads', () => {
    const caps = {
        model_name: 'Ensomi R2',
        model_version: 'r2-1.0.1',
        files: [],
        min_star: 2,
        max_star_exclusive: 6,
        controls: [
            { name: 'jumpstream', status: ControlStatus.WORKS, note: '' },
            { name: 'section_star', status: ControlStatus.EXPERIMENTAL, note: '' },
            { name: 'chordjack', status: ControlStatus.NOT_WORKING, note: '' },
        ],
    };
    assert.deepEqual(activeSectionControls(undefined), []);
    assert.deepEqual(activeSectionControls(caps).map(c => c.name), ['jumpstream', 'section_star']);

    const synced = syncCapabilities(caps, 7.2, [
        { start: '00:10', end: '00:20', kind: 'section_star', strength: 0.5, star: 8.0 },
        { start: '00:20', end: '00:30', kind: 'chordjack', strength: 0.5, star: 3.5 },
        { start: '00:30', end: '00:40', kind: 'jumpstream', strength: 0.7, star: 1.0 },
    ]);
    assert.equal(synced.min, 2);
    assert.equal(synced.max, 5.9);
    assert.equal(synced.star, 5.9);
    assert.deepEqual(synced.sections, [
        { start: '00:10', end: '00:20', kind: 'section_star', strength: 0.5, star: 5.9 },
        { start: '00:30', end: '00:40', kind: 'jumpstream', strength: 0.7, star: 2 },
    ]);
});
