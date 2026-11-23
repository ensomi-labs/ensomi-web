import { ControlStatus, PatternKind, type ModelCapabilities } from '@ensomi/runtime';

export const KINDS: Record<string, PatternKind | 'star'> = {
    jumpstream: PatternKind.JUMPSTREAM,
    chordstream: PatternKind.CHORDSTREAM,
    stream: PatternKind.STREAM,
    jack: PatternKind.JACK,
    chordjack: PatternKind.CHORDJACK,
    section_star: 'star',
};

export interface SectionDraft { start: string; end: string; kind: string; strength: number; star: number }

/** Strip a song file's extension for a default title. */
export const songStem = (fileName: string) => fileName.replace(/\.[^.]+$/, '');

/** Title and artist after a song decodes. Choosing a song clears both inputs first, so `typed` holds only text entered
 * while the song was decoding; otherwise tags from the file win, falling back to the file name's stem and no artist. */
export function songMetadata(fileName: string, info?: { title?: string; artist?: string }, typed?: { title?: string; artist?: string }) {
    const typedTitle = typed?.title?.trim(), typedArtist = typed?.artist?.trim();
    return {
        title: typedTitle || info?.title?.trim() || songStem(fileName),
        artist: typedArtist || info?.artist?.trim() || '',
    };
}

/** Active section controls offered by `caps`. */
export const activeSectionControls = (caps?: ModelCapabilities) =>
    (caps?.controls ?? []).filter(c => c.name in KINDS && c.status !== ControlStatus.NOT_WORKING);

/** Clamps the star slider and any existing section drafts to a newly loaded model's capabilities. */
export function syncCapabilities(caps: ModelCapabilities, currentStar: number, sections: SectionDraft[]) {
    const min = caps.min_star, max = Math.round((caps.max_star_exclusive - 0.1) * 10) / 10;
    const clampStar = (v: number) => Math.min(Math.max(Number.isFinite(v) ? v : min, min), max);
    const allowed = new Set(activeSectionControls(caps).map(c => c.name));
    return {
        min,
        max,
        star: clampStar(currentStar),
        sections: sections.filter(s => allowed.has(s.kind)).map(s => ({ ...s, star: clampStar(s.star) })),
    };
}
