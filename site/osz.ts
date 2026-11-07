import { strToU8, zipSync, type Zippable } from 'fflate';

/** The `.osz` downloads, named by their content.
 *
 * osu!lazer identifies an imported set by its `.osu` files, and reuses an existing set only when every file and name is
 * the same; a set with the same `.osu` but other files replaces it. So the same chart exported again must give the same
 * files, and another chart other ones. The song is `audio-<ID>.<ext>`, its ID from its bytes. A chart's ID comes from
 * the song's ID and the runtime's `.osu` without Title and Artist, so that the same notes on the same song are the same
 * chart whatever they are called; it ends the difficulty name and names the `.osu` and its receipt, which leaves out
 * the run's timings. One `.osz` holds one chart, or the charts of one song staged together, which osu! imports as one
 * beatmap set. */
export interface Chart { id: string; audioName: string; osuName: string; osu: string; receiptName: string; receipt: string; title: string; artist: string; seed: number | bigint }

// The receipt's timings, which differ from run to run of the same generation.
const TIMINGS = new Set(['seconds', 'wall_seconds']);

/** A generated chart with its file names, from the runtime's `.osu` and receipt and the song's ID. */
export async function chartFile(sourceOsu: string, receiptJson: string, audioId: string, chart: { title: string; artist: string; seed: number | bigint }): Promise<Chart> {
    const version = /^Version:(.*)$/m.exec(sourceOsu)?.[1], extension = /^AudioFilename:.*\.([a-z0-9]+)$/im.exec(sourceOsu)?.[1].toLowerCase();
    if (version === undefined || !extension)
        throw new Error('Generated .osu is missing Version or AudioFilename');

    const id = await shortHash(`${audioId}\n${sourceOsu.replace(/^(Title|TitleUnicode|Artist|ArtistUnicode|AudioFilename):.*\n/gm, '')}`);
    const audioName = `audio-${audioId}.${extension}`;
    const osu = sourceOsu
        .replace(/^AudioFilename:.*$/m, () => `AudioFilename:${audioName}`)
        .replace(/^Version:.*$/m, () => `Version:${version} #${id}`);
    const { title, artist, seed } = chart;
    return { id, audioName, osuName: `${safeName(title, 40)}-s${seed}-${id}.osu`, osu, receiptName: `receipt-${id}.json`, receipt: withoutKeys(receiptJson, TIMINGS) + '\n', title, artist, seed };
}

/** One `.osz` of charts of one song, with the song once, and the name it downloads as: one chart's by its title, seed
 * and ID, several by the first one's title, their count and an ID from their IDs. */
export async function bundle(charts: Chart[], audio: Uint8Array) {
    const [first] = charts;
    if (!first || charts.some(c => c.audioName !== first.audioName))
        throw new Error('An .osz holds one or more charts of one song');
    const files: Zippable = { [first.audioName]: [audio, { level: 0 }] };
    for (const c of charts) {
        files[c.osuName] = strToU8(c.osu);
        files[c.receiptName] = strToU8(c.receipt);
    }
    // The seed and ID come after the capped title, so that a long title cannot cut them off.
    const title = safeName(`${first.artist ? `${first.artist} - ` : ''}${first.title}`, 80);
    const name = charts.length === 1 ? `${title} (ensomi R2 s${first.seed} ${first.id})` : `${title} (ensomi R2 ×${charts.length} ${await shortHash(charts.map(c => c.id).sort().join(' '))})`;
    return { name, osz: zipSync(files, { level: 6 }) };
}

/** The first eight hexadecimal digits of the SHA-256 of `data`. */
export async function shortHash(data: Uint8Array | string) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', (typeof data === 'string' ? strToU8(data) : data) as BufferSource));
    return Array.from(hash.subarray(0, 4), b => b.toString(16).padStart(2, '0')).join('');
}

/** `json` without the object members whose key is in `drop`, at any depth. The text is edited, not parsed and written
 * again, so that every other value keeps its digits (a 64-bit seed does not survive `JSON.parse`) and its layout. */
export function withoutKeys(json: string, drop: Set<string>) {
    let at = 0;
    const space = () => {
        const from = at;
        while (at < json.length && ' \t\n\r'.includes(json[at])) at++;
        return json.slice(from, at);
    };
    const string = () => {
        const from = at++;
        while (at < json.length && json[at] !== '"') at += json[at] === '\\' ? 2 : 1;
        return json.slice(from, ++at);
    };
    const value = (): string => {
        const open = json[at];
        if (open === '"') return string();
        if (open !== '{' && open !== '[') {
            const from = at;
            while (at < json.length && !',]} \t\n\r'.includes(json[at])) at++;
            if (at === from) throw new SyntaxError(`Unexpected ${json[at] ?? 'end'} in JSON at position ${at}`);
            return json.slice(from, at);
        }
        at++;
        const close = open === '{' ? '}' : ']', kept: string[] = [];
        let lead = space(), closing = lead;
        while (at < json.length && json[at] !== close) {
            const from = at, key = open === '{' ? JSON.parse(string()) as string : undefined;
            if (key !== undefined) {
                space();
                at++;
                space();
            }
            const item = json.slice(from, at) + value();
            closing = space();
            if (key === undefined || !drop.has(key)) kept.push(lead + item);
            if (json[at] === ',') {
                at++;
                lead = space();
            }
        }
        at++;
        return open + kept.join(',') + (kept.length ? closing : '') + close;
    };
    const before = space(), text = before + value() + json.slice(at);
    JSON.parse(text);
    return text;
}

/** `text` as a file name on Windows, macOS and Linux: path separators, the characters Windows refuses and control
 * characters become spaces, at most `max` characters (code points, so none is cut in half), no leading or trailing dots
 * or spaces, and `untitled` when nothing is left. */
export function safeName(text: string, max: number) {
    const words = text.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return Array.from(words).slice(0, max).join('').replace(/^[. ]+|[. ]+$/g, '') || 'untitled';
}
