'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ACTIONS = new Set(['capabilities', 'inspect', 'preview', 'unlock', 'protect', 'merge', 'split',
  'extract', 'reorder', 'rotate', 'compress', 'images-to-pdf', 'pdf-to-images', 'watermark',
  'page-numbers', 'redact', 'fill-form', 'sign', 'extract-text', 'ocr', 'office-to-pdf']);
for (const action of ['remove-pages', 'repair', 'crop', 'add-text', 'extract-images', 'compare',
  'summarize', 'extract-layout', 'pdf-to-word', 'pdf-to-pptx', 'pdf-to-excel',
  'recover-password', 'scan-to-pdf', 'html-to-pdf', 'annotate', 'pdfa', 'translate', 'ai-extract']) ACTIONS.add(action);
for (const action of ['extract-structured', 'pdf-to-docx', 'pdf-to-xlsx']) ACTIONS.add(action);
for (const action of ['validate-pdfa', 'certificate-sign', 'verify-signature']) ACTIONS.add(action);
const RUNTIME = require('../runtime-paths.cjs').python;
let active = 0;
const failure = (code, message) => ({ ok: false, outputs: [], error: { code, message } });
function terminateTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else child.kill();
}

/** Main-process only. Never expose a raw command or arbitrary executable IPC. */
async function run(action, options = {}, controls = {}) {
  if (!ACTIONS.has(action)) return failure('UNKNOWN_ACTION', 'This PDF action is not supported.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) return failure('INVALID_OPTIONS', 'Options must be an object.');
  if (!fs.existsSync(RUNTIME)) return failure('RUNTIME_MISSING', 'The portable PDF runtime is missing. Re-extract the complete application folder.');
  let request;
  try {
    request = JSON.stringify({ action, options });
    if (Buffer.byteLength(request) > 2 * 1024 * 1024) return failure('REQUEST_TOO_LARGE', 'The PDF request is too large.');
  } catch { return failure('INVALID_OPTIONS', 'Options must contain ordinary JSON values.'); }
  if (active >= 2) return failure('BUSY', 'Two PDF jobs are already running. Wait for one to finish.');
  active++;
  return new Promise((resolve) => {
    let stdout = '', stderrBytes = 0, done = false, child, privateTemp;
    const cleanup = () => {
      if (!privateTemp) return;
      const resolved = path.resolve(privateTemp), parent = path.resolve(os.tmpdir());
      if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('us-pdf-worker-')) return;
      fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      active--;
      clearTimeout(timer);
      controls.signal?.removeEventListener('abort', cancel);
      resolve(result);
    };
    const cancel = () => {
      terminateTree(child);
      finish(failure('CANCELLED', 'The PDF operation was cancelled. Input files were not changed. A partial output folder may remain.'));
    };
    const timer = setTimeout(() => {
      terminateTree(child);
      finish(failure('TIMEOUT', 'The PDF operation exceeded its time limit. Input files were not changed. A partial output folder may remain.'));
    }, ['ocr','translate','ai-extract','pdfa','validate-pdfa'].includes(action) ? 15 * 60 * 1000 : 5 * 60 * 1000);
    if (controls.signal?.aborted) return cancel();
    controls.signal?.addEventListener('abort', cancel, { once: true });
    try {
      privateTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'us-pdf-worker-'));
      child = spawn(RUNTIME, ['-I', '-B', path.join(__dirname, 'engine.py')], {
        cwd: __dirname, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: { HOME:os.homedir(), TMPDIR:privateTemp, LANG:'en_US.UTF-8', SystemRoot: process.env.SystemRoot || 'C:\\Windows',
          WINDIR: process.env.WINDIR || 'C:\\Windows',
          TEMP: privateTemp,
          TMP: privateTemp,
          ProgramFiles: process.env.ProgramFiles || 'C:\\Program Files',
          'ProgramFiles(x86)': process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
          PATH: path.dirname(RUNTIME) },
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data) => {
        stdout += data;
        if (Buffer.byteLength(stdout) > 24 * 1024 * 1024) {
          terminateTree(child);
          finish(failure('OUTPUT_TOO_LARGE', 'The preview or document details exceeded the response limit.'));
        }
      });
      // Do not log raw library diagnostics: they may contain private paths/content.
      child.stderr.on('data', (data) => {
        stderrBytes += data.length;
        if (stderrBytes > 1024 * 1024) terminateTree(child);
      });
      child.on('error', () => finish(failure('RUNTIME_FAILED', 'The local PDF runtime could not start.')));
      child.on('close', () => {
        cleanup();
        if (done) return;
        try {
          const result = JSON.parse(stdout);
          if (typeof result.ok !== 'boolean' || !Array.isArray(result.outputs)) throw new Error('Protocol');
          finish(result);
        } catch { finish(failure('RUNTIME_FAILED', 'The local PDF engine did not return a valid result. Re-extract the complete application folder.')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(request, 'utf8');
      request = null;
    } catch { cleanup(); finish(failure('RUNTIME_FAILED', 'The local PDF runtime could not start.')); }
  });
}

module.exports = { run, capabilities: () => run('capabilities'), actions: Object.freeze([...ACTIONS]) };
