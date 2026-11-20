import { ControlStatus, GenerationPhase, type AudioInfo, type GenerateChartRequest, type GenerationResult, type ModelCapabilities, type SectionRequest } from '@ensomi/runtime';
import { decodeSong } from './audio.js';
import { KINDS, activeSectionControls, songMetadata, songStem, syncCapabilities, type SectionDraft } from './form.js';
import { maniaStar } from './star.js';
import { bundle, chartFile, shortHash, type Chart } from './osz.js';
import { Player, RATES, VISUAL_SPEEDS } from './player.js';
import { PRECISE, type Try } from './precise.js';
import { t } from './i18n.js';

/** The generator page: model loading, song decoding, conditions, progress, result and inspector. */
// The model files at the release tag, not main. Pointing it at another revision also needs a new cache name in worker.ts.
const HUB = 'https://huggingface.co/sed-i/ensomi-r2/resolve/r2-1.0.1/onnx/';
// ?model=<url of a folder holding runtime.json> loads another copy; ?backend=wasm skips WebGPU.
const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => $<HTMLInputElement>(id);

const RECEIPT_TIMES = ['rows', 'prior', 'arrangement', 'export'];
// The stages that read the conditions; they run together when Generate is pressed, without progress of their own.
const CHART_PHASES = [GenerationPhase.ROWS, GenerationPhase.ARRANGEMENT, GenerationPhase.EXPORT];
// A chart further than this from the star asked for says so in words in its result.
const STAR_NEAR = 0.5;

/** `audioId`, the ID of the song's bytes in its `.osz` (site/osz.ts), is taken once, for its first result. `fallback`
 * holds mono PCM when WebAudio decoded a codec Symphonia does not carry (such as Opus); `wav` caches a 16-bit WAV blob
 * when this browser's `<audio>` element cannot play the original container or codec natively. */
interface Song { id: number; file: File; buffer: ArrayBuffer; durationMs: number; decodeSeconds: number; fallback?: { pcm: Float32Array; rate: number }; wav?: Blob; audioId?: Promise<string> }
/** A song's audio stages, run in the worker as soon as the model and the song are ready. */
interface Prep { id: number; song: Song; seconds?: { pcm: number; timing: number }; failed?: boolean }
/** `precise` is set with the Precise difficulty option: the worker then searches from `star` and `seed`, asking only for
 * stars in that range, the star slider's (site/precise.ts). */
interface Job { song: Song; title: string; artist: string; seed: number | bigint; random: boolean; star: number; precise?: [number, number]; sections: SectionRequest[]; prep: Prep }
/** What a Precise difficulty search made: every try, the index of the one whose chart is the result, and their seconds. */
interface Search { tries: Try[]; best: number; seconds: number }

let worker: Worker | undefined, caps: ModelCapabilities | undefined, provider = '', threads = 1, loadSeconds = 0, loading = false;
let song: Song | undefined, prep: Prep | undefined, songCount = 0, prepCount = 0, wavCount = 0, resultCount = 0, job: Job | undefined, generating = false, timer = 0;
let sections: SectionDraft[] = [], urls: string[] = [], wavFallback: Promise<void> | undefined;
let phase = { active: [] as number[], started: 0, seconds: [] as number[] };
const downloaded = new Map<string, [number, number]>();
const pendingDecodes = new Map<number, { resolve: (v: { durationMs: number; info: AudioInfo }) => void; reject: (e: Error) => void }>();
const pendingWavs = new Map<number, { resolve: (v: Uint8Array) => void; reject: (e: Error) => void }>();

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
const providerName = (name: string) => name === 'webgpu' ? 'WebGPU' : threads > 1 ? t.wasmThreads(threads) : t.wasmOneThread;
function clock(ms: number, millis = false) {
    const total = Math.max(0, ms) / 1000, minutes = Math.floor(total / 60), seconds = total - minutes * 60;
    return `${minutes}:${millis ? seconds.toFixed(3).padStart(6, '0') : String(Math.floor(seconds)).padStart(2, '0')}`;
}
function parseClock(text: string) {
    const m = /^(\d{1,3}):([0-5]\d)$/.exec(text.trim());
    return m ? Number(m[1]) * 60000 + Number(m[2]) * 1000 : undefined;
}
function showError(message: string) {
    $('error').textContent = message;
    $('error').hidden = false;
}
const clearError = () => { $('error').hidden = true; };
function resetPhases() {
    phase = { active: [], started: 0, seconds: [] };
    ticking();
}

// 1. Model & Worker
const sourceIsFolder = () => document.querySelector<HTMLInputElement>('input[name="source"]:checked')!.value === 'folder';
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="source"]'))
    radio.addEventListener('change', () => { $('folder-field').hidden = !sourceIsFolder(); });

function ensureWorker() {
    if (worker) return worker;
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = ({ data }) => {
        if (data.type === 'decoded') {
            pendingDecodes.get(data.id)?.resolve({ durationMs: data.durationMs, info: data.info });
            pendingDecodes.delete(data.id);
        }
        else if (data.type === 'decode-error') {
            pendingDecodes.get(data.id)?.reject(Object.assign(new Error(data.message), { unsupported: data.unsupported }));
            pendingDecodes.delete(data.id);
        }
        else if (data.type === 'wav') {
            pendingWavs.get(data.id)?.resolve(data.wav);
            pendingWavs.delete(data.id);
        }
        else if (data.type === 'wav-error') {
            pendingWavs.get(data.id)?.reject(new Error(data.message));
            pendingWavs.delete(data.id);
        }
        else if (data.type === 'file') onFile(data);
        else if (data.type === 'loaded') onLoaded(data);
        else if (data.type === 'phase') markPhase(data);
        else if (data.type === 'prepared') onPrepared(data);
        else if (data.type === 'try') $('run-status').textContent = t.generatingTry(providerName(provider), data.index, data.of);
        else if (data.type === 'result') showResult(data.result, data.precise);
        else if (data.type === 'error') onError(data);
    };
    w.onerror = event => {
        const message = event.message || t.workerFailed;
        worker = undefined;
        caps = undefined;
        for (const p of pendingDecodes.values()) p.reject(new Error(message));
        pendingDecodes.clear();
        for (const p of pendingWavs.values()) p.reject(new Error(message));
        pendingWavs.clear();
        onError({ during: loading ? 'load' : preparing() && !generating ? 'prepare' : 'generate', id: prep?.id, message });
    };
    worker = w;
    return w;
}

function decodeInWorker(id: number, name: string, buffer: ArrayBuffer) {
    const copy = new Uint8Array(buffer.slice(0));
    return new Promise<{ durationMs: number; info: AudioInfo }>((resolve, reject) => {
        pendingDecodes.set(id, { resolve, reject });
        ensureWorker().postMessage({ type: 'decode', id, name, bytes: copy }, [copy.buffer]);
    });
}

function wavInWorker(name: string, buffer: ArrayBuffer) {
    const id = ++wavCount, copy = new Uint8Array(buffer.slice(0));
    return new Promise<Uint8Array>((resolve, reject) => {
        pendingWavs.set(id, { resolve, reject });
        ensureWorker().postMessage({ type: 'wav', id, name, bytes: copy }, [copy.buffer]);
    });
}

$('load').addEventListener('click', () => {
    const folder = field('folder').files;
    if (sourceIsFolder() && !folder?.length)
        return showError(t.chooseFolder);
    clearError();
    loading = true;
    caps = undefined;
    prep = undefined;
    ++prepCount;
    downloaded.clear();
    resetPhases();
    renderSections();
    $('model-meter').hidden = false;
    setMeter(0);
    $('model-status').textContent = t.starting;
    update();
    ensureWorker().postMessage({ type: 'load', base: new URL(params.get('model') ?? HUB, location.href).href, files: sourceIsFolder() ? Array.from(folder!) : undefined, backend: params.get('backend') });
});

function setMeter(fraction: number) { $('model-meter').querySelector('span')!.style.width = `${Math.min(1, fraction) * 100}%`; }

function onFile(data: { path: string; loaded: number; size: number; cached: boolean }) {
    if (!loading) return;
    // Files download in parallel: the meter follows the bytes of every file started so far.
    downloaded.set(data.path, [data.loaded, data.size]);
    let loaded = 0, size = 0;
    for (const [bytes, total] of downloaded.values()) {
        loaded += bytes;
        size += total || bytes;
    }
    setMeter(size ? loaded / size : 0);
    $('model-status').textContent = data.cached
        ? t.readingCache(mb(loaded))
        : t.downloading(mb(loaded), mb(size));
}

function onLoaded(data: { capabilities: ModelCapabilities; provider: string; threads: number; seconds: number }) {
    caps = data.capabilities;
    provider = data.provider;
    threads = data.threads;
    loadSeconds = data.seconds;
    loading = false;
    $('model-meter').hidden = true;
    $('model-status').textContent = t.modelReady(`${caps.model_name} ${caps.model_version}`, providerName(provider), loadSeconds.toFixed(1));
    const star = field('star'), synced = syncCapabilities(caps, Number(star.value), sections);
    star.min = String(synced.min);
    star.max = String(synced.max);
    star.value = String(synced.star);
    $('star-value').textContent = synced.star.toFixed(1);
    sections = synced.sections;
    renderSections();
    startPrepare();
    update();
}

function onError(data: { during: string; id?: number; message: string }) {
    if (data.during === 'load') {
        loading = false;
        $('model-meter').hidden = true;
        $('model-status').textContent = t.modelNotLoaded;
        showError(t.loadFailed(data.message));
    }
    else if (data.during === 'prepare') {
        // A generation waiting for these stages fails with them; Generate then runs them again.
        if (!prep || data.id !== prep.id) return;
        prep.failed = true;
        phase.active = [];
        if (generating && job?.prep.id === prep.id) generating = false;
        ticking();
        showError(t.timingFailed(data.message));
    }
    else {
        const alreadyFailedPrep = Boolean(job?.prep.failed);
        finishRun();
        if (!alreadyFailedPrep) showError(t.generationFailed(data.message));
    }
    update();
}

// 2. Song
field('song').addEventListener('change', async () => {
    const id = ++songCount, file = field('song').files?.[0];
    clearError();
    song = undefined;
    prep = undefined;
    ++prepCount;
    // Choosing a song resets song-specific conditions and the stage.
    sections = [];
    field('title').value = '';
    field('artist').value = '';
    resetPhases();
    renderSections();
    clearStage();
    update();
    if (!file) {
        $('song-status').textContent = t.noSong;
        return;
    }
    $('song-status').textContent = t.decoding(file.name);
    try {
        const start = performance.now(), buffer = await file.arrayBuffer();
        if (id !== songCount) return;
        let durationMs: number, info: AudioInfo | undefined, fallback: { pcm: Float32Array; rate: number } | undefined;
        try {
            const decoded = await decodeInWorker(id, file.name, buffer);
            durationMs = decoded.durationMs;
            info = decoded.info;
        }
        catch {
            if (id !== songCount) return;
            const web = await decodeSong(buffer);
            durationMs = web.pcm.length / web.rate * 1000;
            fallback = web;
        }
        if (id !== songCount) return;
        song = { id, file, buffer, durationMs, decodeSeconds: (performance.now() - start) / 1000, fallback };
        $('song-status').textContent = t.decoded(file.name, clock(song.durationMs), song.decodeSeconds.toFixed(1));
        const meta = songMetadata(file.name, info, { title: field('title').value, artist: field('artist').value });
        field('title').value = meta.title;
        field('artist').value = meta.artist;
    }
    catch {
        if (id !== songCount) return;
        $('song-status').textContent = t.noSong;
        showError(t.cannotDecode(file.name));
    }
    renderSections();
    startPrepare();
    update();
});

/** Runs the song's audio stages (PCM, BeatThis and the beat grid) as soon as the model and the song are both ready, so
 * that Generate runs only the stages that read the conditions. */
function startPrepare() {
    if (!caps || !song || song.durationMs < 3000) return;
    const id = ++prepCount, fallback = song.fallback;
    ensureWorker().postMessage({ type: 'prepare', id, songId: song.id, pcm: fallback?.pcm, rate: fallback?.rate });
    prep = { id, song };
    ticking();
}
const preparing = () => Boolean(prep && !prep.seconds && !prep.failed);

function onPrepared(data: { id: number; seconds: { pcm: number; timing: number } }) {
    if (data.id !== prep?.id) return;
    prep.seconds = data.seconds;
    phase.seconds[GenerationPhase.LOADING] = data.seconds.pcm;
    phase.seconds[GenerationPhase.TIMING] = data.seconds.timing;
    phase.active = generating ? CHART_PHASES : [];
    phase.started = performance.now();
    ticking();
    update();
}

// 3. Conditions
field('star').addEventListener('input', () => { $('star-value').textContent = Number(field('star').value).toFixed(1); });
field('seed').addEventListener('input', update);
$('precise-tries').textContent = String(PRECISE.tries);
$('new-seed').addEventListener('click', () => {
    field('seed').value = String(randomSeed());
    update();
});

/** A random seed for a blank seed field, shown with the result so that it reproduces the chart. The core seeds its
 * generators from the low 32 bits. */
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

/** The seed entered, 'random' for a blank field, or undefined for text that is not a seed. */
function seedValue(): number | bigint | 'random' | undefined {
    const text = field('seed').value.trim();
    if (!text) return 'random';
    if (!/^\d{1,20}$/.test(text) || BigInt(text) > 0xffffffffffffffffn) return undefined;
    const n = BigInt(text);
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
}

const sectionOptions = () => activeSectionControls(caps);
function kindLabel(name: string, status: ControlStatus) {
    const label = name === 'section_star' ? t.starTarget : name[0].toUpperCase() + name.slice(1);
    return status === ControlStatus.EXPERIMENTAL ? t.experimental(label) : label;
}

$('add-section').addEventListener('click', () => {
    const options = sectionOptions();
    if (!options.length) return;
    sections.push({ start: '00:00', end: '00:08', kind: options[0].name, strength: 0.5, star: Number(field('star').value) });
    renderSections();
    update();
});

function renderSections() {
    const list = $('section-list'), currentCaps = caps, options = sectionOptions();
    list.replaceChildren();
    if (!currentCaps || !options.length) return;
    sections.forEach((section, i) => {
        const row = document.createElement('div'), isStar = section.kind === 'section_star';
        row.className = 'section-row';
        row.innerHTML = `<label>${t.start} <input type="text" class="start" spellcheck="false" autocomplete="off"></label>
<label>${t.end} <input type="text" class="end" spellcheck="false" autocomplete="off"></label>
<label>${t.kind} <select class="kind"></select></label>
<label class="value-label"><span><span class="value-name"></span><output></output></span><input type="range" class="value"></label>
<button type="button" class="remove">×</button>
<p class="note"></p>`;
        const q = <T extends Element>(selector: string) => row.querySelector(selector) as T;
        const start = q<HTMLInputElement>('.start'), end = q<HTMLInputElement>('.end'), kind = q<HTMLSelectElement>('.kind'), value = q<HTMLInputElement>('.value'), output = q<HTMLOutputElement>('output');
        start.value = section.start;
        end.value = section.end;
        for (const option of options) kind.add(new Option(kindLabel(option.name, option.status), option.name, false, option.name === section.kind));
        q('.value-name').textContent = isStar ? t.star : t.strength;
        Object.assign(value, isStar ? { min: String(currentCaps.min_star), max: field('star').max, step: '0.1' } : { min: '0', max: '1', step: '0.05' });
        value.value = String(isStar ? section.star : section.strength);
        output.textContent = isStar ? section.star.toFixed(1) : section.strength.toFixed(2);
        q('.note').textContent = options.find(o => o.name === section.kind)?.note ?? '';
        q('.remove').setAttribute('aria-label', t.removeSection(i + 1));
        start.addEventListener('input', () => { section.start = start.value; update(); });
        end.addEventListener('input', () => { section.end = end.value; update(); });
        kind.addEventListener('change', () => { section.kind = kind.value; renderSections(); update(); });
        value.addEventListener('input', () => {
            if (isStar) section.star = Number(value.value);
            else section.strength = Number(value.value);
            output.textContent = isStar ? section.star.toFixed(1) : section.strength.toFixed(2);
        });
        q('.remove').addEventListener('click', () => { sections.splice(i, 1); renderSections(); update(); });
        list.append(row);
    });
}

/** The section requests, or the first problem in plain words. Same rules as the runtime and the macOS app. */
function sectionRequests(): SectionRequest[] | string {
    const requests: SectionRequest[] = [];
    for (const [i, section] of sections.entries()) {
        const name = t.section(i + 1), start = parseClock(section.start), end = parseClock(section.end), target = KINDS[section.kind];
        if (start === undefined || end === undefined) return t.sectionClock(name);
        if (end <= start) return t.sectionOrder(name);
        if (end > song!.durationMs) return t.sectionInside(name, clock(song!.durationMs));
        if (end - start < 8000 || end - start > 32000) return t.sectionLength(name);
        requests.push(target === 'star' ? { start_ms: start, end_ms: end, star: section.star } : { start_ms: start, end_ms: end, pattern: { kind: target, strength: section.strength } });
    }
    const sorted = requests.slice().sort((a, b) => a.start_ms - b.start_ms);
    for (let i = 1; i < sorted.length; i++)
        if (sorted[i].start_ms < sorted[i - 1].end_ms) return t.sectionOverlap;
    return requests;
}

function update() {
    const checked = caps && song ? sectionRequests() : [], sectionError = typeof checked === 'string' ? checked : '';
    $('section-error').textContent = sectionError;
    $('section-error').hidden = !sectionError;
    const blocker = !caps ? (loading ? t.loadingModel : t.loadToStart)
        : !song ? t.chooseSong
            : song.durationMs < 3000 ? t.songTooShort
                : seedValue() === undefined ? t.badSeed
                    : sectionError ? t.fixSections : '';
    $<HTMLButtonElement>('generate-button').disabled = $<HTMLButtonElement>('regenerate').disabled = generating || Boolean(blocker);
    $<HTMLButtonElement>('add-section').disabled = generating || !caps || !song || !sectionOptions().length;
    $<HTMLButtonElement>('load').disabled = loading || generating;
    // A generation starts from the stages prepared when it was asked for; another song waits until it is done.
    field('song').disabled = generating;
    if (!generating) $('run-status').textContent = blocker || (preparing() ? t.timing : prep?.seconds ? t.timingReady : t.readyToGenerate);
}

// Generate, from the conditions or from the result's Regenerate button, which does the same without scrolling back up.
function generate() {
    if (!song || !caps) return;
    const requests = sectionRequests(), entered = seedValue();
    if (typeof requests === 'string' || entered === undefined) return;
    clearError();
    // Stages that failed run again first.
    if (!prep || prep.failed) startPrepare();
    // A blank seed draws a new seed for each generation, as in the app; the result shows the seed used.
    const title = field('title').value.trim() || songStem(song.file.name), artist = field('artist').value.trim(), seed = entered === 'random' ? randomSeed() : entered;
    job = { song, title, artist, seed, random: entered === 'random', star: Number(field('star').value), precise: field('precise').checked ? [Number(field('star').min), Number(field('star').max)] : undefined, sections: requests, prep: prep! };
    generating = true;
    phase.seconds.length = GenerationPhase.ROWS;
    if (job.prep.seconds) {
        phase.active = CHART_PHASES;
        phase.started = performance.now();
    }
    ticking();
    update();
    $('run-status').textContent = t.generating(providerName(provider));
    const request: GenerateChartRequest = { audio: { asset_id: song.file.name }, star: job.star, seed, controls: { sections: requests }, title, ...(artist ? { artist } : {}) };
    ensureWorker().postMessage({ type: 'generate', prepId: job.prep.id, request, precise: job.precise, audio: { name: song.file.name, bytes: new Uint8Array(song.buffer) } });
}
$('generate-button').addEventListener('click', generate);
$('regenerate').addEventListener('click', generate);

/** Progress of the audio stages: Prepare, then Timing. */
function markPhase(data: { id: number; phase: number }) {
    if (data.id !== prep?.id) return;
    const now = performance.now();
    if (data.phase === GenerationPhase.LOADING) phase = { active: [], started: now, seconds: [] };
    for (const p of phase.active) phase.seconds[p] = (now - phase.started) / 1000;
    phase.active = [data.phase];
    phase.started = now;
    renderPhases();
}

function renderPhases() {
    for (const item of $('phases').querySelectorAll<HTMLElement>('li')) {
        const p = Number(item.dataset.phase), active = phase.active.includes(p);
        // A phase running alone counts its seconds; the stages after timing get theirs from the receipt.
        const seconds = active ? (phase.active.length === 1 ? (performance.now() - phase.started) / 1000 : undefined) : phase.seconds[p];
        item.className = active ? 'active' : seconds !== undefined ? 'done' : '';
        item.textContent = t.phases[p] + (seconds !== undefined ? ` · ${seconds.toFixed(1)} s` : '');
    }
}

/** Redraws the phases, every 200 ms while a song is being prepared or a chart generated. */
function ticking() {
    const busy = generating || preparing();
    if (busy && !timer) timer = window.setInterval(renderPhases, 200);
    if (!busy && timer) {
        clearInterval(timer);
        timer = 0;
    }
    renderPhases();
}

function finishRun() {
    generating = false;
    phase.active = phase.active.filter(p => !CHART_PHASES.includes(p));
    ticking();
}

// Result
const player = new Player($<HTMLCanvasElement>('lanes'), $<HTMLCanvasElement>('overview'), $<HTMLAudioElement>('audio'), ms => {
    $('clock').textContent = `${clock(ms, true)} / ${clock(player.duration)}`;
});

// When `<audio>` cannot play the uploaded container or codec natively (for instance ALAC in Chrome or Ogg Vorbis in
// Safari), transcode a 16-bit PCM WAV blob through the Wasm core so the live inspector plays it seamlessly.
player.audio.addEventListener('error', () => {
    const currentJob = job, id = resultCount;
    if (!currentJob || currentJob.song.wav || wavFallback) return;
    wavFallback = (async () => {
        try {
            const wav = await wavInWorker(currentJob.song.file.name, currentJob.song.buffer);
            currentJob.song.wav = new Blob([wav as BlobPart], { type: 'audio/wav' });
            if (id !== resultCount) return;
            const wavUrl = URL.createObjectURL(currentJob.song.wav);
            urls.push(wavUrl);
            player.audio.src = wavUrl;
            player.seek(player.targetMs);
        }
        catch { /* preview playback stays unavailable if neither the browser nor Symphonia can render PCM */ }
        finally {
            if (id === resultCount) wavFallback = undefined;
        }
    })();
});

/** The star the chart came out at beside the star asked for, and in words how far apart they are when that is more than
 * half a star, which a first chart often is. */
function starText(measured: number, requested: number) {
    const gap = measured - requested;
    return Math.abs(gap) > STAR_NEAR ? t.starFar(measured.toFixed(2), requested.toFixed(1), Math.abs(gap).toFixed(1), gap > 0) : t.starResult(measured.toFixed(2), requested.toFixed(1));
}

/** Shows a generated chart. After a Precise difficulty search it is the closest chart, `search` says how it was found,
 * and the seed in its `.osu`, its file names and the line under the lanes is its own try's; the Seed row keeps the seed
 * the search started from, which gives this chart again with the same star and Precise difficulty. */
function showResult(result: GenerationResult, search?: Search) {
    const done = job!, detail = JSON.parse(result.receipt.receipt_json), objects = result.chart.objects, holds = objects.filter(o => o.end_ms !== undefined).length;
    // The receipt times its own chart; a search took the time of every chart it made.
    const chosen = search?.tries[search.best], took: number = search?.seconds ?? detail.seconds.total;
    phase.seconds[GenerationPhase.ROWS] = detail.seconds.rows;
    phase.seconds[GenerationPhase.ARRANGEMENT] = detail.seconds.prior + detail.seconds.arrangement;
    phase.seconds[GenerationPhase.EXPORT] = detail.seconds.export;
    finishRun();
    ++resultCount;
    wavFallback = undefined;
    for (const url of urls) URL.revokeObjectURL(url);
    const audio = URL.createObjectURL(done.song.wav ?? done.song.file);
    urls = [audio];
    showChart(result, chosen ? { ...done, seed: chosen.seed } : done).catch(error => showError(t.generationFailed(error instanceof Error ? error.message : String(error))));

    const facts: [string, string][] = [
        [t.receipt.model, `${result.receipt.model_name} ${result.receipt.model_version}`],
        [t.receipt.provider, providerName(provider)],
        [t.receipt.song, `${done.song.file.name} · ${clock(done.song.durationMs)}`],
        [t.receipt.star, starText(maniaStar(objects), done.star)],
        [t.receipt.seed, done.random ? t.randomSeed(String(done.seed)) : String(done.seed)],
        // The downloaded receipt records what this chart asked the model for, not the star and seed the search began with.
        ...(chosen ? [[t.receipt.precise, t.preciseResult(search!.tries.length, chosen.r.toFixed(2), String(chosen.seed))] as [string, string]] : []),
        [t.receipt.notes, t.noteCounts(objects.length.toLocaleString('en'), (objects.length - holds).toLocaleString('en'), holds.toLocaleString('en'))],
        [t.receipt.headRows, Number(detail.rows.K).toLocaleString('en')],
        [t.receipt.tempo, detail.rows.segments.map((s: number[]) => (60000 / s[1]).toFixed(1)).join(', ') + ' BPM'],
        [t.receipt.sections, done.sections.length ? String(done.sections.length) : t.none],
    ];
    $('receipt').replaceChildren(...facts.flatMap(([label, value]) => {
        const dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        return [dt, dd];
    }));
    // The audio stages ran when the song was chosen; the receipt times the stages after them, and its total is theirs.
    const stages = done.prep.seconds!;
    const rows: [string, number, boolean?][] = [[t.modelLoad, loadSeconds], [t.audioDecode, done.song.decodeSeconds], [t.times.pcm, stages.pcm], [t.times.timing, stages.timing], ...RECEIPT_TIMES.map((key): [string, number] => [t.times[key], detail.seconds[key]]), [t.total, detail.seconds.total, true], ...(search ? [[t.preciseTotal, search.seconds] as [string, number]] : [])];
    $('times').replaceChildren(...rows.map(([label, seconds, total]) => {
        const tr = document.createElement('tr'), th = document.createElement('th'), td = document.createElement('td');
        th.scope = 'row';
        th.textContent = label;
        td.textContent = `${seconds.toFixed(2)} s`;
        if (total) tr.className = 'total';
        tr.append(th, td);
        return tr;
    }));
    $('times-total').textContent = t.generatedIn(took.toFixed(1));

    $('result').hidden = false;
    player.audio.src = audio;
    player.load({ chart: result.chart, segments: detail.rows.segments, sections: done.sections });
    $('identity').textContent = [done.title, done.artist, `ensomi R2 s${chosen?.seed ?? done.seed}`].filter(Boolean).join(' · ');
    $('run-status').textContent = t.doneIn(took.toFixed(1));
    update();
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Downloads. The runtime's own .osz (result.osz) names every chart generated.osu; the page's are named by their content
// (site/osz.ts). Stage puts the shown chart in the .osz, which then holds the staged charts instead of the shown one
// alone; pressed again, it takes the chart out. The stage holds charts of the chosen song only, in page memory: choosing
// a song empties it, and so does downloading it. A result of a song chosen before can be downloaded but not staged.
let shown: { chart: Chart; song: Song; audio: Uint8Array } | undefined, oszUrl = '', chartCount = 0, oszCount = 0;
const staged = new Map<string, Chart>();

/** Names the result's chart, which Stage and the .osz link then offer. */
async function showChart(result: GenerationResult, done: Job) {
    const id = ++chartCount, audio = new Uint8Array(done.song.buffer);
    shown = undefined;
    void refreshDownloads();
    done.song.audioId ??= shortHash(audio);
    const chart = await chartFile(result.osu, result.receipt.receipt_json, await done.song.audioId, done);
    if (id !== chartCount) return;
    shown = { chart, song: done.song, audio };
    await refreshDownloads();
}

/** Labels Stage and the .osz link and points the link at the staged charts, or at the shown chart alone when none is
 * staged. Without a chart, both wait. */
async function refreshDownloads() {
    const id = ++oszCount, link = $<HTMLAnchorElement>('get-osz');
    link.removeAttribute('href');
    link.textContent = staged.size ? t.downloadBundle(staged.size) : t.downloadOsz;
    $<HTMLButtonElement>('stage').disabled = !shown || shown.song !== song;
    $('stage').setAttribute('aria-pressed', String(Boolean(shown && staged.has(shown.chart.id))));
    if (!shown) return;
    const { name, osz } = await bundle(staged.size ? [...staged.values()] : [shown.chart], shown.audio);
    if (id !== oszCount) return;
    // A download that has just started may still be reading the previous archive.
    const previous = oszUrl;
    if (previous) setTimeout(() => URL.revokeObjectURL(previous), 60_000);
    oszUrl = URL.createObjectURL(new Blob([osz as BlobPart], { type: 'application/zip' }));
    Object.assign(link, { href: oszUrl, download: `${name}.osz` });
}

/** Empties the stage and relabels the downloads. */
function clearStage() {
    staged.clear();
    void refreshDownloads();
}

$('stage').addEventListener('click', () => {
    if (!shown || shown.song !== song) return;
    if (!staged.delete(shown.chart.id)) staged.set(shown.chart.id, shown.chart);
    void refreshDownloads();
});
// Downloading the staged charts empties the stage, after the browser has followed the link: emptying it in this
// handler would take the link's target away first.
$('get-osz').addEventListener('click', () => {
    if (staged.size && $('get-osz').hasAttribute('href')) setTimeout(clearStage);
});

// Inspector controls
async function togglePlay() {
    if (wavFallback) await wavFallback;
    player.toggle();
}
$('play').addEventListener('click', () => { void togglePlay(); });
$('restart').addEventListener('click', () => player.seek(0));
// A new result's audio stops playback without a pause event (the media element load algorithm fires emptied instead).
function showPlaying() {
    const playing = !player.audio.paused;
    $('play').textContent = playing ? t.pause : t.play;
    $('play').setAttribute('aria-pressed', String(playing));
}
for (const type of ['play', 'pause', 'emptied']) player.audio.addEventListener(type, showPlaying);

function presets(id: string, values: number[], initial: number, label: (v: number) => string, apply: (v: number) => void) {
    const box = $(id), buttons = values.map(v => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label(v);
        button.setAttribute('aria-pressed', String(v === initial));
        button.addEventListener('click', () => {
            for (const b of buttons) b.setAttribute('aria-pressed', String(b === button));
            apply(v);
        });
        return button;
    });
    box.append(...buttons);
}
presets('rates', RATES, 1, v => `${v}×`, v => { player.audio.defaultPlaybackRate = v; player.audio.playbackRate = v; });
presets('speeds', VISUAL_SPEEDS, player.speed, String, v => { player.speed = v; });
// Volume only scales the file down: the slider runs 0 to 100% and an audio element's volume tops out at 1.
const volume = field('volume');
function setVolume() {
    const percent = Number(volume.value), text = `${percent}%`;
    player.audio.volume = percent / 100;
    $('volume-value').textContent = text;
    volume.setAttribute('aria-valuetext', text);
}
volume.addEventListener('input', setVolume);
setVolume();

// Space plays or pauses; Left and Right seek 5 s. Typing targets and focused buttons keep their own keys.
document.addEventListener('keydown', event => {
    if ($('result').hidden || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : document.body;
    if (target.closest('textarea, select, [contenteditable="true"], input:not([type="range"])')) return;
    if (event.key === ' ' && !target.closest('button, a, summary')) {
        event.preventDefault();
        void togglePlay();
    }
    else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !target.closest('input')) {
        event.preventDefault();
        player.seek(player.time + (event.key === 'ArrowLeft' ? -5000 : 5000));
    }
});

update();
