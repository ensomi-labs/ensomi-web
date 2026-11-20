/** Fault injection confined to the served test worker; product files stay unchanged. The worker keeps the page's
 * COEP header: a cross-origin isolated page does not start a worker without one. */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function makeWav(seconds = 4, rate = 22050) {
    const samples = seconds * rate, buf = Buffer.alloc(44 + samples * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + samples * 2, 4);
    buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++)
        buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / rate) * 8000), 44 + i * 2);
    return buf;
}

const cases = [
    ['no-adapter', 'navigator.gpu.requestAdapter=async()=>null;', false],
    ['device-failure', `const nativeRequestAdapter=navigator.gpu.requestAdapter.bind(navigator.gpu);navigator.gpu.requestAdapter=async(...args)=>{const a=await nativeRequestAdapter(...args);if(a)a.requestDevice=async()=>{throw new Error('Injected GPU device failure for browser test');};return a;};`, false],
    ['run-failure', `const nativeRequestAdapter=navigator.gpu.requestAdapter.bind(navigator.gpu);navigator.gpu.requestAdapter=async(...args)=>{const a=await nativeRequestAdapter(...args);if(!a)return a;const nativeRequestDevice=a.requestDevice.bind(a);a.requestDevice=async(...dArgs)=>{const d=await nativeRequestDevice(...dArgs);let ran=false;const nativeCreateShaderModule=d.createShaderModule.bind(d);d.createShaderModule=desc=>{ran=true;return nativeCreateShaderModule(desc);};const nativeCreateComputePipeline=d.createComputePipeline.bind(d);d.createComputePipeline=desc=>{ran=true;return nativeCreateComputePipeline(desc);};const nativePopErrorScope=d.popErrorScope.bind(d);d.popErrorScope=async()=>{const err=await nativePopErrorScope();return err||!ran?err:Object.setPrototypeOf({message:'Injected compute pipeline validation error for browser test'},globalThis.GPUValidationError?.prototype??Error.prototype);};return d;};return a;};`, true],
];

const runtime = resolve(import.meta.dirname, '../..'), repo = resolve(runtime, '../..'), out = join(runtime, 'artifacts/browser-test');
await mkdir(join(out, 'screenshots'), { recursive: true });
const worker = await readFile(join(repo, 'public/worker.js'), 'utf8'), wav = makeWav();
const browser = await chromium.launch({ channel: 'chrome', headless: !process.env.ENSOMI_HEADED, args: process.env.ENSOMI_CHROME_ARGS?.split(' ') ?? [] }), results = [];
try {
    for (const [name, prefix, needsPrepare] of cases) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.route('**/worker.js', r => r.fulfill({ contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'credentialless' }, body: prefix + '\n' + worker }));
        const page = await context.newPage(), logs = [];
        page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
        await page.goto((process.env.ENSOMI_TEST_URL ?? 'http://127.0.0.1:8087') + '/?model=/model/onnx/');
        await page.locator('#load').click();
        await page.waitForFunction(() => document.querySelector('#model-status').textContent.includes('is ready') || !document.querySelector('#error').hidden, null, { timeout: 120000 });
        const initialStatus = await page.locator('#model-status').textContent();
        if (needsPrepare && initialStatus?.includes('is ready')) {
            await page.locator('#song').setInputFiles({ name: 'test.wav', mimeType: 'audio/wav', buffer: wav });
            await page.waitForFunction(() => document.querySelector('#run-status').textContent.includes('Timing found') || !document.querySelector('#error').hidden, null, { timeout: 120000 });
        }
        const data = await page.evaluate(() => ({
            status: document.querySelector('#model-status').textContent,
            runStatus: document.querySelector('#run-status').textContent,
            error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
        }));
        const pass = !data.error && data.status.includes('WebAssembly') && (!needsPrepare || data.runStatus.includes('Timing found'));
        if (!pass) process.exitCode = 1;
        results.push({ name, pass, initialStatus, ...data, logs });
        await page.locator(data.error ? '#error' : '#model-status').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(out, `screenshots/fallback-${name}.png`) });
        await context.close();
    }
}
finally {
    await writeFile(join(out, 'fallback.json'), JSON.stringify(results, null, 2));
    console.log(results.map(r => ({ name: r.name, pass: r.pass, initialStatus: r.initialStatus, status: r.status, runStatus: r.runStatus, error: r.error })));
    await browser.close();
}
