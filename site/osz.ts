import { strToU8, zipSync } from 'fflate';

/** The downloads of one result: its `.osz`, its `.osu` and the name both download as.
 *
 * The runtime's `.osu` is reproducible, the same for the same song, seed and conditions, and its `.osz` names every chart
 * `generated.osu` beside `audio.<ext>`. osu!lazer identifies an imported set by its `.osu` files alone and deletes an
 * earlier set with the same `.osu` but other files, such as a receipt with other timings; osu! may also put two archives
 * into one folder or set. So every export gets an ID of its own, in the `.osu` (the audio file's name and the
 * difficulty name), in the archive's chart and audio file names and in the download name. The `.osu` download is the
 * archive's. */
export function chartDownloads(sourceOsu: string, receiptJson: string, audio: Uint8Array, chart: { title: string; artist: string; seed: number | bigint }, id = exportId()) {
    if (!/^[0-9a-f]{8}$/.test(id))
        throw new Error('Export ID must be eight lowercase hexadecimal digits');
    const version = /^Version:(.*)$/m.exec(sourceOsu)?.[1], extension = /^AudioFilename:.*\.([a-z0-9]+)$/im.exec(sourceOsu)?.[1].toLowerCase();
    if (version === undefined || !extension)
        throw new Error('Generated .osu is missing Version or AudioFilename');

    const audioName = `audio-${id}.${extension}`;
    const osu = sourceOsu
        .replace(/^AudioFilename:.*$/m, () => `AudioFilename:${audioName}`)
        .replace(/^Version:.*$/m, () => `Version:${version} #${id}`);
    const osz = zipSync({
        [`${safeName(chart.title, 40)}-s${chart.seed}-${id}.osu`]: strToU8(osu),
        [audioName]: [audio, { level: 0 }],
        'receipt.json': strToU8(receiptJson + '\n'),
    }, { level: 6 });
    // The seed and ID come after the capped title, so that a long title cannot cut them off.
    const name = `${safeName(`${chart.artist ? `${chart.artist} - ` : ''}${chart.title}`, 80)} (ensomi R2 s${chart.seed} ${id})`;
    return { name, osu, osz };
}

/** Eight random hexadecimal digits, drawn for each result. */
export const exportId = () => crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, '0');

/** `text` as a file name on Windows, macOS and Linux: path separators, the characters Windows refuses and control
 * characters become spaces, at most `max` characters (code points, so none is cut in half), no leading or trailing dots
 * or spaces, and `untitled` when nothing is left. */
export function safeName(text: string, max: number) {
    const words = text.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return Array.from(words).slice(0, max).join('').replace(/^[. ]+|[. ]+$/g, '') || 'untitled';
}
