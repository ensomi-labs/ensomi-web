import { strToU8, zipSync } from 'fflate';

/** The runtime's generated.osu is reproducible; only the website's downloadable copy is made import-distinct.
 * osu! may merge difficulties with the same metadata, and two maps merged into one set must not share audio.mp3. */
export function importDistinctExport(
    sourceOsu: string,
    receiptJson: string,
    audio: Uint8Array,
    title: string,
    seed: number | bigint,
    exportId: string,
) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(exportId))
        throw new Error('Export ID must be a UUID');

    const version = /^Version:([^\r\n]+)$/m.exec(sourceOsu), audioLine = /^AudioFilename:([^\r\n]+)$/m.exec(sourceOsu);
    if (!version || !audioLine)
        throw new Error('Generated .osu is missing Version or AudioFilename');

    const originalAudio = audioLine[1].trim(), extension = /\.([a-z0-9]+)$/i.exec(originalAudio)?.[1].toLowerCase();
    if (!extension || /[\\/\u0000-\u001f]/.test(originalAudio))
        throw new Error('Generated .osu has an unsafe audio filename');

    // A distinct difficulty and audio name matter even if osu! merges two exports under one song.
    const audioName = `audio-${exportId}.${extension}`;
    const osu = sourceOsu
        .replace(/^AudioFilename:[^\r\n]+$/m, `AudioFilename:${audioName}`)
        .replace(/^Version:[^\r\n]+$/m, `Version:${version[1]} [${exportId}]`);

    const safeTitle = Array.from(title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
        .slice(0, 60).join('').replace(/^[. ]+|[. ]+$/g, '') || 'untitled';
    const osuName = `${safeTitle}-s${seed}-${exportId}.osu`;
    const osz = zipSync({
        [osuName]: strToU8(osu),
        [audioName]: [audio, { level: 0 }],
        'receipt.json': strToU8(receiptJson + '\n'),
    }, { level: 6 });

    return { osu, osz, osuName, exportId };
}
