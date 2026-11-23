/**
 * Browser fallback decoder for codecs the Wasm runtime's Symphonia decoder does not carry (such as Opus in `.opus`,
 * `.ogg`, `.webm` or `.mp4`). Decodes at the file's own sample rate, read from its header, so that WebAudio only
 * decodes and the runtime's core converts the rate as the Python release does, and reads `Title` and `Artist` tags from
 * the file's container. A file whose rate is not found is decoded at 48000 Hz when Opus is detected and 44100 Hz
 * otherwise.
 */
const FALLBACK_RATE = 44100;
const utf8 = new TextDecoder();

function is(b: Uint8Array, at: number, text: string) {
    if (at < 0 || at + text.length > b.length) return false;
    for (let i = 0; i < text.length; i++)
        if (b[at + i] !== text.charCodeAt(i)) return false;
    return true;
}
const u32le = (b: Uint8Array, at: number) => (b[at] | b[at + 1] << 8 | b[at + 2] << 16 | b[at + 3] << 24) >>> 0;
const u32be = (b: Uint8Array, at: number) => (b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3]) >>> 0;
const cleanTag = (text: string) => text.replace(/\0+$/, '').trim();

/** Mono PCM at the file's own rate, channels averaged, with any container Title and Artist tags. */
export async function decodeSong(buffer: ArrayBuffer) {
    const bytes = new Uint8Array(buffer), found = headerRate(bytes), rate = found && found >= 8000 && found <= 192000 ? found : FALLBACK_RATE;
    const decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(buffer.slice(0)), pcm = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const samples = decoded.getChannelData(channel);
        for (let i = 0; i < pcm.length; i++)
            pcm[i] += samples[i] / decoded.numberOfChannels;
    }
    return { pcm, rate, info: headerTags(bytes) };
}

/** The sample rate in the header of a WAV, FLAC, Ogg (Vorbis or Opus), MP4 (AAC or Opus), WebM/Matroska or MP3 file. */
export function headerRate(b: Uint8Array): number | undefined {
    if (is(b, 0, 'RIFF') && is(b, 8, 'WAVE')) {
        for (let at = 12; at + 16 <= b.length; at += 8 + u32le(b, at + 4) + (u32le(b, at + 4) & 1))
            if (is(b, at, 'fmt ')) return u32le(b, at + 12);
        return undefined;
    }
    if (is(b, 0, 'fLaC')) return b.length >= 21 ? (b[18] << 12 | b[19] << 4 | b[20] >> 4) : undefined;
    if (is(b, 0, 'OggS')) {
        if (b.length < 27) return undefined;
        const packet = 27 + b[26];
        return is(b, packet, '\x01vorbis') && packet + 16 <= b.length ? u32le(b, packet + 12) : is(b, packet, 'OpusHead') ? 48000 : undefined;
    }
    if (is(b, 4, 'ftyp')) {
        const limit = Math.min(b.length, 65536);
        for (let at = 8; at + 8 <= limit; at++) {
            if (b[at] === 0x6d && is(b, at, 'mp4a') && at + 30 <= b.length) return b[at + 28] << 8 | b[at + 29];
            if (b[at] === 0x4f && is(b, at, 'Opus')) return 48000;
        }
        return undefined;
    }
    // Matroska / WebM (EBML magic 1A 45 DF A3): Opus decodes at 48 kHz; otherwise read SamplingFrequency (0xB5).
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
        const limit = Math.min(b.length, 65536), view = new DataView(b.buffer, b.byteOffset, b.byteLength);
        for (let at = 4; at + 8 <= limit; at++)
            if ((b[at] === 0x4f && is(b, at, 'OpusHead')) || (b[at] === 0x41 && is(b, at, 'A_OPUS'))) return 48000;
        for (let at = 4; at + 6 <= limit; at++) {
            if (b[at] === 0xb5 && b[at + 1] === 0x84) {
                const f = Math.round(view.getFloat32(at + 2, false));
                if (f >= 8000 && f <= 192000) return f;
            }
            if (b[at] === 0xb5 && b[at + 1] === 0x88 && at + 10 <= limit) {
                const f = Math.round(view.getFloat64(at + 2, false));
                if (f >= 8000 && f <= 192000) return f;
            }
        }
        return undefined;
    }
    // Known non-MP3 containers whose payload bytes must not be scanned as MPEG sync words.
    if (is(b, 0, 'FORM') || is(b, 0, 'caff')) return undefined;
    // MP3: the first frame header after an ID3v2 tag.
    let at = is(b, 0, 'ID3') && b.length >= 10 ? 10 + (b[6] << 21 | b[7] << 14 | b[8] << 7 | b[9]) + (b[5] & 0x10 ? 10 : 0) : 0;
    for (const end = Math.min(b.length - 3, at + 65536); at < end; at++) {
        const version = b[at + 1] >> 3 & 3, layer = b[at + 1] >> 1 & 3, bitrate = b[at + 2] >> 4, index = b[at + 2] >> 2 & 3;
        if (b[at] === 0xff && (b[at + 1] & 0xe0) === 0xe0 && version !== 1 && layer !== 0 && bitrate !== 15 && index !== 3)
            return [44100, 48000, 32000][index] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    }
    return undefined;
}

/** Container `Title` and `Artist` tags for Ogg (Opus or Vorbis), Matroska/WebM and MP4/ISO-BMFF files. */
export function headerTags(b: Uint8Array): { title?: string; artist?: string } {
    if (is(b, 0, 'OggS')) return oggTags(b);
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ebmlTags(b);
    if (is(b, 4, 'ftyp') || is(b, 4, 'moov')) return mp4Tags(b);
    return {};
}

function hasAsciiKey(b: Uint8Array, at: number, len: number, key: string) {
    if (len <= key.length || b[at + key.length] !== 0x3d) return false;
    for (let i = 0; i < key.length; i++)
        if ((b[at + i] | 0x20) !== key.charCodeAt(i)) return false;
    return true;
}

function oggTags(b: Uint8Array): { title?: string; artist?: string } {
    let audioSerial: number | undefined, skippingFirst = false, packetDone = false, total = 0;
    const chunks: Uint8Array[] = [];
    for (let at = 0; !packetDone && at + 27 <= b.length && is(b, at, 'OggS');) {
        const type = b[at + 5], serial = u32le(b, at + 14), segments = b[at + 26], body = at + 27 + segments;
        if (body > b.length) break;
        let pageLen = 0;
        for (let i = 0; i < segments; i++) pageLen += b[at + 27 + i];
        if (body + pageLen > b.length) break;
        if (audioSerial === undefined && (type & 0x02) !== 0 && segments > 0 && (is(b, body, 'OpusHead') || is(b, body, '\x01vorbis'))) {
            audioSerial = serial;
            skippingFirst = true;
        }
        if (serial === audioSerial) {
            if (chunks.length > 0 && (type & 0x01) === 0) break;
            let pos = body;
            for (let i = 0; i < segments; i++) {
                const len = b[at + 27 + i];
                if (skippingFirst) {
                    pos += len;
                    if (len < 255) skippingFirst = false;
                    continue;
                }
                if (len > 0) {
                    chunks.push(b.subarray(pos, pos + len));
                    total += len;
                    pos += len;
                }
                if (len < 255) {
                    packetDone = true;
                    break;
                }
            }
        }
        at = body + pageLen;
    }
    if (!packetDone || !total) return {};
    let pkt: Uint8Array;
    if (chunks.length === 1) pkt = chunks[0];
    else {
        pkt = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
            pkt.set(c, at);
            at += c.length;
        }
    }
    const head = is(pkt, 0, 'OpusTags') ? 8 : is(pkt, 0, '\x03vorbis') ? 7 : 0;
    if (!head || head + 8 > pkt.length) return {};
    let pos = head + 4 + u32le(pkt, head);
    if (pos + 4 > pkt.length) return {};
    const count = u32le(pkt, pos);
    pos += 4;
    let title: string | undefined, artist: string | undefined;
    for (let i = 0; i < count && pos + 4 <= pkt.length; i++) {
        const len = u32le(pkt, pos);
        pos += 4;
        if (pos + len > pkt.length) break;
        if (!title && hasAsciiKey(pkt, pos, len, 'title'))
            title = cleanTag(utf8.decode(pkt.subarray(pos + 6, pos + len))) || undefined;
        else if (!artist && hasAsciiKey(pkt, pos, len, 'artist'))
            artist = cleanTag(utf8.decode(pkt.subarray(pos + 7, pos + len))) || undefined;
        if (title && artist) break;
        pos += len;
    }
    return { ...(title ? { title } : {}), ...(artist ? { artist } : {}) };
}

function ebml(b: Uint8Array, at: number, end: number) {
    if (at >= end) return undefined;
    const idFirst = b[at];
    if (idFirst < 0x10) return undefined;
    const idLen = Math.clz32(idFirst) - 23, sAt = at + idLen;
    if (sAt >= end) return undefined;
    const sFirst = b[sAt];
    if (sFirst === 0) return undefined;
    const sLen = Math.clz32(sFirst) - 23, body = sAt + sLen;
    if (body > end) return undefined;
    let id = 0;
    for (let i = 0; i < idLen; i++) id = id * 256 + b[at + i];
    const mask = 0x80 >> (sLen - 1);
    let size = sFirst & (mask - 1), unknown = size === mask - 1;
    for (let i = 1; i < sLen; i++) {
        const byte = b[sAt + i];
        size = size * 256 + byte;
        if (byte !== 0xff) unknown = false;
    }
    return { id, body, size: unknown ? -1 : size };
}

function ebmlTags(b: Uint8Array): { title?: string; artist?: string } {
    let infoTitle: string | undefined, tagTitle: string | undefined, artist: string | undefined;
    for (let at = 0; at < b.length;) {
        const top = ebml(b, at, b.length);
        if (!top) break;
        if (top.id === 0x18538067) {
            const segEnd = top.size < 0 ? b.length : Math.min(b.length, top.body + top.size);
            for (let pos = top.body; pos < segEnd;) {
                const child = ebml(b, pos, segEnd);
                if (!child || child.size < 0 || child.body + child.size > segEnd) break;
                const childEnd = child.body + child.size;
                if (child.id === 0x1549a966) {
                    for (let p = child.body; p < childEnd;) {
                        const item = ebml(b, p, childEnd);
                        if (!item || item.size < 0 || item.body + item.size > childEnd) break;
                        if (item.id === 0x7ba9 && !infoTitle)
                            infoTitle = cleanTag(utf8.decode(b.subarray(item.body, item.body + item.size))) || undefined;
                        p = item.body + item.size;
                    }
                }
                else if (child.id === 0x1254c367) {
                    for (let p = child.body; p < childEnd;) {
                        const tag = ebml(b, p, childEnd);
                        if (!tag || tag.size < 0 || tag.body + tag.size > childEnd) break;
                        const tagEnd = tag.body + tag.size;
                        if (tag.id === 0x7373) {
                            let targetType: number | undefined, tTitle: string | undefined, tArtist: string | undefined;
                            for (let q = tag.body; q < tagEnd;) {
                                const sub = ebml(b, q, tagEnd);
                                if (!sub || sub.size < 0 || sub.body + sub.size > tagEnd) break;
                                const subEnd = sub.body + sub.size;
                                if (sub.id === 0x63c0) {
                                    for (let r = sub.body; r < subEnd;) {
                                        const tgt = ebml(b, r, subEnd);
                                        if (!tgt || tgt.size < 0 || tgt.body + tgt.size > subEnd) break;
                                        if (tgt.id === 0x68ca && tgt.size >= 1 && tgt.size <= 6) {
                                            let v = 0;
                                            for (let k = 0; k < tgt.size; k++) v = v * 256 + b[tgt.body + k];
                                            targetType = v;
                                        }
                                        r = tgt.body + tgt.size;
                                    }
                                }
                                else if (sub.id === 0x67c8) {
                                    let name = '', val = '';
                                    for (let r = sub.body; r < subEnd;) {
                                        const st = ebml(b, r, subEnd);
                                        if (!st || st.size < 0 || st.body + st.size > subEnd) break;
                                        if (st.id === 0x45a3) name = cleanTag(utf8.decode(b.subarray(st.body, st.body + st.size))).toLowerCase();
                                        else if (st.id === 0x4487) val = cleanTag(utf8.decode(b.subarray(st.body, st.body + st.size)));
                                        r = st.body + st.size;
                                    }
                                    if (val && name === 'title' && !tTitle) tTitle = val;
                                    else if (val && name === 'artist' && !tArtist) tArtist = val;
                                }
                                q = subEnd;
                            }
                            if (targetType === undefined || targetType === 30) {
                                if (tTitle && !tagTitle) tagTitle = tTitle;
                                if (tArtist && !artist) artist = tArtist;
                            }
                        }
                        p = tagEnd;
                    }
                }
                pos = childEnd;
            }
            break;
        }
        if (top.size < 0 || top.body + top.size > b.length) break;
        at = top.body + top.size;
    }
    const title = tagTitle ?? infoTitle;
    return { ...(title ? { title } : {}), ...(artist ? { artist } : {}) };
}

function mp4Box(b: Uint8Array, at: number, end: number) {
    if (at + 8 > end) return undefined;
    const size32 = u32be(b, at);
    if (size32 === 0) return { body: at + 8, end };
    if (size32 === 1) {
        if (at + 16 > end) return undefined;
        const size64 = Number((BigInt(u32be(b, at + 8)) << 32n) | BigInt(u32be(b, at + 12)));
        return size64 >= 16 && size64 <= end - at ? { body: at + 16, end: at + size64 } : undefined;
    }
    return size32 >= 8 && size32 <= end - at ? { body: at + 8, end: at + size32 } : undefined;
}

function findBox(b: Uint8Array, at: number, end: number, type: string) {
    while (at < end) {
        const box = mp4Box(b, at, end);
        if (!box) return undefined;
        if (is(b, at + 4, type)) return box;
        at = box.end;
    }
    return undefined;
}

function mp4Tags(b: Uint8Array): { title?: string; artist?: string } {
    const moov = findBox(b, 0, b.length, 'moov');
    const udta = moov && findBox(b, moov.body, moov.end, 'udta');
    const meta = udta && findBox(b, udta.body, udta.end, 'meta');
    if (!meta || meta.end - meta.body < 8) return {};
    const metaStart = meta.end - meta.body >= 12 && !(is(b, meta.body + 4, 'hdlr') || is(b, meta.body + 4, 'ilst') || is(b, meta.body + 4, 'keys'))
        ? meta.body + 4 : meta.body;
    const ilst = findBox(b, metaStart, meta.end, 'ilst');
    if (!ilst) return {};
    let title: string | undefined, artist: string | undefined, utf16be: TextDecoder | undefined;
    for (let at = ilst.body; at < ilst.end;) {
        const item = mp4Box(b, at, ilst.end);
        if (!item) break;
        const wantTitle = !title && is(b, at + 4, '\xa9nam'), wantArtist = !artist && is(b, at + 4, '\xa9ART');
        if (wantTitle || wantArtist) {
            const data = findBox(b, item.body, item.end, 'data');
            if (data && data.end - data.body >= 8) {
                const kind = u32be(b, data.body), payload = b.subarray(data.body + 8, data.end);
                const raw = kind === 1 ? utf8.decode(payload) : kind === 2 ? (utf16be ??= new TextDecoder('utf-16be')).decode(payload) : '';
                const val = cleanTag(raw);
                if (val) {
                    if (wantTitle) title = val;
                    else artist = val;
                }
            }
            if (title && artist) break;
        }
        at = item.end;
    }
    return { ...(title ? { title } : {}), ...(artist ? { artist } : {}) };
}
