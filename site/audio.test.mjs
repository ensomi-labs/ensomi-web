import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const { headerRate, headerTags } = await import('./audio.ts');
const enc = new TextEncoder();

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

const u32le = n => [n & 0xff, n >> 8 & 0xff, n >> 16 & 0xff, n >>> 24 & 0xff];
const u32be = n => [n >>> 24 & 0xff, n >>> 16 & 0xff, n >>> 8 & 0xff, n & 0xff];

function oggPage(serial, headerType, segments) {
    return bytes('OggS', [0, headerType], new Array(8).fill(0), u32le(serial), new Array(8).fill(0), [segments.length], segments.map(s => s.length), ...segments);
}

function lacePacket(pkt) {
    const segs = [];
    for (let at = 0; at < pkt.length; at += 255)
        segs.push(pkt.subarray(at, Math.min(pkt.length, at + 255)));
    if (pkt.length % 255 === 0)
        segs.push(new Uint8Array(0));
    return segs;
}

function vorbisComments(magic, vendor, comments) {
    const v = enc.encode(vendor), encoded = comments.map(c => enc.encode(c));
    return bytes(magic, u32le(v.length), v, u32le(encoded.length), ...encoded.flatMap(c => [u32le(c.length), c]));
}

function ebmlEl(idBytes, payload, sizeWidth = 0) {
    const body = bytes(...(Array.isArray(payload) ? payload : [payload]));
    let size;
    if (sizeWidth === 8) {
        size = new Uint8Array(8);
        size[0] = 0x01;
        let rem = body.length;
        for (let i = 7; i >= 1; i--) {
            size[i] = rem & 0xff;
            rem = Math.floor(rem / 256);
        }
    }
    else if (body.length < 0x7f) size = [0x80 | body.length];
    else size = [0x40 | (body.length >> 8), body.length & 0xff];
    return bytes(idBytes, size, body);
}

function mp4Atom(type, payload, large = false) {
    const body = bytes(...(Array.isArray(payload) ? payload : [payload]));
    return large
        ? bytes(u32be(1), type, u32be(0), u32be(16 + body.length), body)
        : bytes(u32be(8 + body.length), type, body);
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

test('reads Ogg OpusTags and Vorbis comments across single, multi-segment, exact-255 and multi-page packets', () => {
    const bos = oggPage(0x10203040, 0x02, [bytes('OpusHead', new Array(11).fill(0))]);

    // Single-segment OpusTags with case-insensitive keys, UTF-8 CJK and '=' inside values.
    const single = bytes(bos, oggPage(0x10203040, 0x00, [vorbisComments('OpusTags', 'Lavf', ['Title=  夜に駆ける = Pt.2 ', 'ARTIST=YOASOBI'])]));
    assert.deepEqual(headerTags(single), { title: '夜に駆ける = Pt.2', artist: 'YOASOBI' });

    // Multi-page continuation packet with large METADATA_BLOCK_PICTURE= skipped and interleaved non-audio serial ignored.
    const picture = 'METADATA_BLOCK_PICTURE=' + 'A'.repeat(1200);
    const bigTags = vorbisComments('OpusTags', 'Lavf63.1.102', [picture, 'title=   ', 'title=Real Song', 'artist=Real Artist', 'title=Later Duplicate']);
    const laced = lacePacket(bigTags);
    const otherStream = oggPage(0x99999999, 0x00, [vorbisComments('OpusTags', 'other', ['TITLE=Wrong Stream', 'ARTIST=Wrong'])]);
    const multiPage = bytes(
        oggPage(0xdeadbeef, 0x02, [bytes('fishead\0', new Array(12).fill(0))]),
        bos,
        otherStream,
        oggPage(0x10203040, 0x00, laced.slice(0, 2)),
        otherStream,
        oggPage(0x10203040, 0x01, laced.slice(2, 4)),
        oggPage(0x10203040, 0x01, [...laced.slice(4), bytes([1, 2, 3, 4])]),
    );
    assert.deepEqual(headerTags(multiPage), { title: 'Real Song', artist: 'Real Artist' });

    // Exact multiple of 255 bytes terminated by a 0-length segment, using Vorbis \x03vorbis header.
    const baseVorbis = vorbisComments('\x03vorbis', 'Xiph', ['TITLE=Exact Multiple', 'ARTIST=Vorbis Artist', 'PAD=']);
    const padLen = (255 - (baseVorbis.length % 255)) % 255;
    const exact255 = vorbisComments('\x03vorbis', 'Xiph', ['TITLE=Exact Multiple', 'ARTIST=Vorbis Artist', 'PAD=' + 'x'.repeat(padLen)]);
    assert.equal(exact255.length % 255, 0);
    const exactLaced = lacePacket(exact255);
    assert.equal(exactLaced.at(-1).length, 0);
    const vorbisBos = oggPage(7, 0x02, [bytes('\x01vorbis', new Array(23).fill(0))]);
    assert.deepEqual(headerTags(bytes(vorbisBos, oggPage(7, 0x00, exactLaced))), { title: 'Exact Multiple', artist: 'Vorbis Artist' });

    // Truncated / malformed comment length stops cleanly without throwing, preserving earlier parsed tags.
    const goodEntry = enc.encode('TITLE=Survives');
    const malformed = bytes('OpusTags', u32le(0), u32le(2), u32le(goodEntry.length), goodEntry, u32le(999999), [1, 2]);
    assert.deepEqual(headerTags(bytes(bos, oggPage(0x10203040, 0x00, [malformed]))), { title: 'Survives' });
    assert.deepEqual(headerTags(bytes('OggS', [0, 2])), {});
});

test('reads Matroska and WebM tags across Clusters, unknown-size Segment, NUL padding and TargetTypeValue', () => {
    const simpleTag = (name, value) => ebmlEl([0x67, 0xc8], [
        ebmlEl([0x45, 0xa3], enc.encode(name)),
        ebmlEl([0x44, 0x87], bytes(enc.encode(value), [0, 0])),
    ]);
    const tagWithTarget = (targetType, items) => ebmlEl([0x73, 0x73], [
        ebmlEl([0x63, 0xc0], targetType === undefined ? [] : [ebmlEl([0x68, 0xca], new Uint8Array([targetType]))]),
        ...items,
    ]);

    // FFmpeg MKV layout: Info.Title before Cluster, Tags after Cluster with 8-byte EBML sizes and album TargetTypeValue=50.
    const mkv = bytes(
        ebmlEl([0x1a, 0x45, 0xdf, 0xa3], ebmlEl([0x42, 0x82], 'matroska')),
        bytes([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), // unknown-size Segment
        ebmlEl([0x15, 0x49, 0xa9, 0x66], [ebmlEl([0x7b, 0xa9], bytes(enc.encode('Info Song Title'), [0]))], 8),
        ebmlEl([0x1f, 0x43, 0xb6, 0x75], new Uint8Array(80000), 8), // > 64 KiB Cluster skipped in O(1)
        ebmlEl([0x12, 0x54, 0xc3, 0x67], [
            tagWithTarget(50, [simpleTag('TITLE', 'Album Name'), simpleTag('ARTIST', 'Album Artist')]),
            tagWithTarget(undefined, [simpleTag('ARTIST', 'Track Artist')]),
        ], 8),
    );
    assert.deepEqual(headerTags(mkv), { title: 'Info Song Title', artist: 'Track Artist' });

    // Track-targeted (TargetTypeValue=30) SimpleTag TITLE overrides Info.Title.
    const webmOverride = bytes(
        ebmlEl([0x1a, 0x45, 0xdf, 0xa3], ebmlEl([0x42, 0x82], 'webm')),
        ebmlEl([0x18, 0x53, 0x80, 0x67], [
            ebmlEl([0x15, 0x49, 0xa9, 0x66], [ebmlEl([0x7b, 0xa9], enc.encode('Fallback Info'))]),
            ebmlEl([0x12, 0x54, 0xc3, 0x67], [
                tagWithTarget(30, [simpleTag('title', 'Stream Title'), simpleTag('artist', 'Stream Artist')]),
            ]),
        ], 8),
    );
    assert.deepEqual(headerTags(webmOverride), { title: 'Stream Title', artist: 'Stream Artist' });
});

test('reads MP4 udta.meta.ilst tags when moov follows mdat, supporting 64-bit largesize and UTF-16BE without aART clobber', () => {
    const dataAtom = (typeIndicator, payloadBytes) => mp4Atom('data', [u32be(typeIndicator), [0, 0, 0, 0], payloadBytes]);
    const utf16be = text => {
        const out = new Uint8Array(text.length * 2);
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            out[i * 2] = code >> 8;
            out[i * 2 + 1] = code & 0xff;
        }
        return out;
    };

    const ilst = mp4Atom('ilst', [
        mp4Atom('aART', dataAtom(1, enc.encode('Wrong Album Artist'))),
        mp4Atom('\xa9nam', dataAtom(1, enc.encode('MP4 Opus Title'))),
        mp4Atom('\xa9ART', dataAtom(2, utf16be('UTF16 アーティスト'))),
    ]);
    const meta = mp4Atom('meta', [[0, 0, 0, 0], mp4Atom('hdlr', new Uint8Array(24)), ilst]);
    const moov = mp4Atom('moov', mp4Atom('udta', meta), true);
    const mp4 = bytes(
        mp4Atom('ftyp', 'isom\0\0\x02\0'),
        mp4Atom('mdat', new Uint8Array(70000), true),
        moov,
    );
    assert.deepEqual(headerTags(mp4), { title: 'MP4 Opus Title', artist: 'UTF16 アーティスト' });
});

test('reads embedded OpusTags from QA fixture if present on disk', () => {
    const qaPath = '/private/tmp/ensomi-pr34-qa-f748/tagged-fallback.opus';
    if (!existsSync(qaPath)) return;
    const raw = new Uint8Array(readFileSync(qaPath));
    assert.equal(headerRate(raw), 48000);
    assert.deepEqual(headerTags(raw), { title: 'Embedded Opus Title', artist: 'Embedded Opus Artist' });
});
