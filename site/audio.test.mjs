import assert from 'node:assert/strict';
import test from 'node:test';

const { headerRate } = await import('./audio.ts');

function bytes(...parts) {
    const chunks = parts.map(p => typeof p === 'string' ? Uint8Array.from(p, c => c.charCodeAt(0)) : Uint8Array.from(p));
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}

test('reads sample rates across WAV, FLAC, Ogg Vorbis/Opus, MP4 AAC/Opus, WebM and MP3', () => {
    const wav = bytes('RIFF', [36, 0, 0, 0], 'WAVEfmt ', [16, 0, 0, 0, 1, 0, 2, 0, 0x80, 0xbb, 0, 0, 0, 0, 0, 0, 4, 0, 16, 0]);
    assert.equal(headerRate(wav), 48000);

    const flac = bytes('fLaC', [0, 0, 0, 34, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0b, 0xb8, 0x00, 0]);
    assert.equal(headerRate(flac), 48000);

    const oggVorbis = bytes('OggS', new Array(22).fill(0), [1, 30], '\x01vorbis', [0, 0, 0, 0, 2, 0x44, 0xac, 0, 0]);
    assert.equal(headerRate(oggVorbis), 44100);

    const oggOpus = bytes('OggS', new Array(22).fill(0), [1, 19], 'OpusHead', new Array(11).fill(0));
    assert.equal(headerRate(oggOpus), 48000);

    const mp4Aac = bytes([0, 0, 0, 20], 'ftypM4A ', [0, 0, 0, 0], 'mp4a', new Array(24).fill(0), [0xac, 0x44]);
    assert.equal(headerRate(mp4Aac), 44100);

    const mp4Opus = bytes([0, 0, 0, 20], 'ftypmp42', [0, 0, 0, 0], 'Opus', new Array(16).fill(0));
    assert.equal(headerRate(mp4Opus), 48000);

    const webmOpus = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82], 'webm', [0x86, 0x86], 'A_OPUS', [0xff, 0xfb, 0x90, 0x00]);
    assert.equal(headerRate(webmOpus), 48000);

    const f64Rate = new Uint8Array(8);
    new DataView(f64Rate.buffer).setFloat64(0, 96000, false);
    const mkv96k = bytes([0x1a, 0x45, 0xdf, 0xa3, 0xb5, 0x88], f64Rate, [0xff, 0xfb, 0x90, 0x00]);
    assert.equal(headerRate(mkv96k), 96000);

    const mp3 = bytes('ID3', [4, 0, 0, 0, 0, 0, 4, 1, 2, 3, 4, 0xff, 0xfb, 0x90, 0x00]);
    assert.equal(headerRate(mp3), 44100);
});

test('does not mistake AIFF, CAF or untagged EBML payload bytes for an MP3 frame header', () => {
    const fakeMp3Frame = [0xff, 0xfb, 0x98, 0x00]; // would look like 32 kHz MP3 if scanned
    assert.equal(headerRate(bytes('FORM', [0, 0, 0, 20], 'AIFF', fakeMp3Frame)), undefined);
    assert.equal(headerRate(bytes('caff', [0, 1, 0, 0], fakeMp3Frame)), undefined);
    assert.equal(headerRate(bytes([0x1a, 0x45, 0xdf, 0xa3], fakeMp3Frame)), undefined);
});
