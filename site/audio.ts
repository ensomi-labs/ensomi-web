/**
 * Browser fallback decoder for codecs the Wasm runtime's Symphonia decoder does not carry (such as Opus in `.opus`,
 * `.ogg`, `.webm` or `.mp4`). Decodes at the file's own sample rate, read from its header, so that WebAudio only
 * decodes and the runtime's core converts the rate as the Python release does. A file whose rate is not found is
 * decoded at 48000 Hz when Opus is detected and 44100 Hz otherwise.
 */
const FALLBACK_RATE = 44100;

/** Mono PCM at the file's own rate, channels averaged. */
export async function decodeSong(buffer: ArrayBuffer) {
    const found = headerRate(new Uint8Array(buffer)), rate = found && found >= 8000 && found <= 192000 ? found : FALLBACK_RATE;
    const decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(buffer.slice(0)), pcm = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const samples = decoded.getChannelData(channel);
        for (let i = 0; i < pcm.length; i++)
            pcm[i] += samples[i] / decoded.numberOfChannels;
    }
    return { pcm, rate };
}

/** The sample rate in the header of a WAV, FLAC, Ogg (Vorbis or Opus), MP4 (AAC or Opus), WebM/Matroska or MP3 file. */
export function headerRate(b: Uint8Array): number | undefined {
    const is = (at: number, text: string) => at + text.length <= b.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
    const u32 = (at: number) => (b[at] | b[at + 1] << 8 | b[at + 2] << 16 | b[at + 3] << 24) >>> 0;
    if (is(0, 'RIFF') && is(8, 'WAVE')) {
        for (let at = 12; at + 16 <= b.length; at += 8 + u32(at + 4) + (u32(at + 4) & 1))
            if (is(at, 'fmt ')) return u32(at + 12);
        return undefined;
    }
    if (is(0, 'fLaC')) return b.length >= 21 ? (b[18] << 12 | b[19] << 4 | b[20] >> 4) : undefined;
    if (is(0, 'OggS')) {
        if (b.length < 27) return undefined;
        const packet = 27 + b[26];
        return is(packet, '\x01vorbis') && packet + 16 <= b.length ? u32(packet + 12) : is(packet, 'OpusHead') ? 48000 : undefined;
    }
    if (is(4, 'ftyp')) {
        const limit = Math.min(b.length, 65536);
        for (let at = 8; at + 8 <= limit; at++) {
            if (b[at] === 0x6d && is(at, 'mp4a') && at + 30 <= b.length) return b[at + 28] << 8 | b[at + 29];
            if (b[at] === 0x4f && is(at, 'Opus')) return 48000;
        }
        return undefined;
    }
    // Matroska / WebM (EBML magic 1A 45 DF A3): Opus decodes at 48 kHz; otherwise read SamplingFrequency (0xB5).
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
        const limit = Math.min(b.length, 65536), view = new DataView(b.buffer, b.byteOffset, b.byteLength);
        for (let at = 4; at + 8 <= limit; at++)
            if ((b[at] === 0x4f && is(at, 'OpusHead')) || (b[at] === 0x41 && is(at, 'A_OPUS'))) return 48000;
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
    if (is(0, 'FORM') || is(0, 'caff')) return undefined;
    // MP3: the first frame header after an ID3v2 tag.
    let at = is(0, 'ID3') && b.length >= 10 ? 10 + (b[6] << 21 | b[7] << 14 | b[8] << 7 | b[9]) + (b[5] & 0x10 ? 10 : 0) : 0;
    for (const end = Math.min(b.length - 3, at + 65536); at < end; at++) {
        const version = b[at + 1] >> 3 & 3, layer = b[at + 1] >> 1 & 3, bitrate = b[at + 2] >> 4, index = b[at + 2] >> 2 & 3;
        if (b[at] === 0xff && (b[at + 1] & 0xe0) === 0xe0 && version !== 1 && layer !== 0 && bitrate !== 15 && index !== 3)
            return [44100, 48000, 32000][index] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    }
    return undefined;
}
