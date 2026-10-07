// Summarises the performance reports shadPS4-AYOUB1080p writes to shad_log.txt when
// perf_tuning.ini has perf_log = 1 (and gpu_profile = 1 for the GPU busy figure).
'use strict';
const fs = require('fs');

const num = (s) => Number(s);
const pctl = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

function parse(text) {
  const seconds = [], slow = [], threads = new Map(), profiles = new Map(), readbackCode = new Map();
  let curProfile = null;
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/Perf readback code\s+(\d+) x\s+guest (\S+)/))) {
      readbackCode.set(m[2], (readbackCode.get(m[2]) || 0) + num(m[1]));
      continue;
    }
    if ((m = line.match(/Perf: ([\d.]+) fps \| frame avg ([\d.]+) ms max ([\d.]+) ms \| >33ms (\d+) >50ms (\d+) \| gpu thread work (\d+)% spin (\d+)%/))) {
      const s = { fps: num(m[1]), avg: num(m[2]), max: num(m[3]), over33: num(m[4]), over50: num(m[5]), cpWork: num(m[6]) };
      const g = line.match(/\| gpu busy (\d+)% submissions/);
      if (g) s.gpuBusy = num(g[1]);
      const p = line.match(/pipelines (\d+) \((\d+) ms compile, (\d+) ms stall, (\d+) skipped\)/);
      if (p) Object.assign(s, { pipelines: num(p[1]), pipeCompileMs: num(p[2]), pipeStallMs: num(p[3]), pipeSkipped: num(p[4]) });
      const r = line.match(/readbacks R(\d+) W(\d+) D(\d+) \((\d+) ms stalled/);
      if (r) Object.assign(s, { readbacks: num(r[1]) + num(r[2]), readbackStallMs: num(r[4]) });
      const w = line.match(/gpu waits (\d+) \((\d+) ms\)/);
      if (w) s.gpuWaitMs = num(w[2]);
      const f = line.match(/faults R(\d+) W(\d+) \| protect (\d+) \((\d+) ms\)/);
      if (f) Object.assign(s, { faults: num(f[1]) + num(f[2]), protectMs: num(f[4]) });
      const d = line.match(/draws\/frame (\d+) dispatches\/frame (\d+)/);
      if (d) Object.assign(s, { draws: num(d[1]), dispatches: num(d[2]) });
      seconds.push(s);
    } else if ((m = line.match(/Perf: ([\d.]+) fps over ([\d.]+) s, worst frame ([\d.]+) ms, (\d+) frames over \d+ ms, gpu thread (\d+)% busy/))) {
      // rayhlancaner-png FixBuild: one summary per ~10 s, spread over its seconds.
      const s = { fps: num(m[1]), avg: 1000 / Math.max(num(m[1]), 0.1), max: num(m[3]), over33: 0, over50: 0, cpWork: num(m[5]) };
      const g = line.match(/host GPU busy ([\d.]+) ms a frame/);
      if (g) s.gpuBusy = Math.round(num(g[1]) * s.fps / 10);
      const d = line.match(/ ([\d.]+) draws, ([\d.]+) dispatches,/);
      if (d) Object.assign(s, { draws: Math.round(num(d[1])), dispatches: Math.round(num(d[2])) });
      const n = Math.max(1, Math.round(num(m[2])));
      for (let i = 0; i < n; i++) seconds.push({ ...s, over50: i === 0 ? num(m[4]) : 0 });
    } else if ((m = line.match(/Perf slow frame #\d+: ([\d.]+) ms \| shaders \d+ \(([\d.]+) ms\) pipelines \d+ \(([\d.]+) ms compile, ([\d.]+) ms stall, \d+ skipped\) \| gpu waits \d+ \(([\d.]+) ms\) \| readbacks R\d+ W\d+ D\d+ \(([\d.]+) ms stalled.*?protect \d+ \(([\d.]+) ms\) \| buffer uploads \d+ \([\d.]+ MB, ([\d.]+) ms\) \| image refresh \d+ \([\d.]+ MB, ([\d.]+) ms\)/))) {
      slow.push({ at: seconds.length, ms: num(m[1]), shaderMs: num(m[2]), pipeCompileMs: num(m[3]), pipeStallMs: num(m[4]),
        gpuWaitMs: num(m[5]), readbackMs: num(m[6]), protectMs: num(m[7]), uploadMs: num(m[8]), imageMs: num(m[9]) });
    } else if ((m = line.match(/Perf threads: (.*)$/))) {
      for (const part of m[1].split(' | ')) {
        const t = part.match(/^(.*) (\d+)% \(kernel (\d+)%\)$/);
        if (!t || t[1].startsWith('tid ')) continue;
        const e = threads.get(t[1]) || { samples: [], kernel: [] };
        e.samples.push(num(t[2])); e.kernel.push(num(t[3]));
        threads.set(t[1], e);
      }
    } else if ((m = line.match(/Perf profile \[(.+?)\]: (\d+) samples/))) {
      curProfile = m[1];
    } else if (curProfile && (m = line.match(/Perf profile \[(.+?)\]\s+([\d.]+)% (\S+)(?: \((.*)\))?$/))) {
      const key = m[4] ? `${m[3]} (${m[4]})` : m[3];
      const p = profiles.get(m[1]) || new Map();
      p.set(key, (p.get(key) || 0) + num(m[2]));
      profiles.set(m[1], p);
    }
  }
  return { seconds, slow, threads, profiles, readbackCode };
}

/** Big Picture launches append to the log: keep only the last emulator session. */
function lastSession(text) {
  const marker = 'Starting shadps4 emulator';
  const at = text.lastIndexOf(marker);
  if (at <= 0) return text;
  return text.slice(text.lastIndexOf('\n', at) + 1);
}

function summarize(fullText, { skipSeconds = 20 } = {}) {
  const text = lastSession(fullText);
  const { seconds: all, slow, threads, profiles, readbackCode } = parse(text);
  const crashLine = text.split(/\r?\n/).find((l) => l.includes('Unhandled Exception code'));
  const crash = crashLine && `CRASHED after ~${all.length} s: ${crashLine.replace(/^.*SignalHandler: /, '')} (${crashLine.match(/\((.*?)\)/)?.[1]})`;
  if (!all.length) return { error: crash || 'No "Perf:" lines: set perf_log = 1 in perf_tuning.ini (ps4kit launch --perf).' };
  if (crash && all.length <= skipSeconds + 10) return { error: crash };
  // Skip the start (boot, logos) and seconds without frames (menus paused, loading).
  const sec = all.slice(Math.min(skipSeconds, Math.max(0, all.length - 10))).filter((s) => s.fps > 0);
  const fps = sec.map((s) => s.fps).sort((a, b) => a - b);
  const sum = (k) => sec.reduce((x, s) => x + (s[k] || 0), 0);
  const out = {
    seconds: sec.length,
    fps: { avg: avg(fps), p5: pctl(fps, 0.05), p50: pctl(fps, 0.5), below30: sec.filter((s) => s.fps < 29).length / sec.length },
    frameMaxMs: Math.max(...sec.map((s) => s.max)),
    framesOver33: sum('over33'), framesOver50: sum('over50'),
    // gpu busy is only measured with gpu_profile = 1 (otherwise the field stays 0)
    gpuBusy: sec.some((s) => s.gpuBusy > 0) ? avg(sec.filter((s) => s.gpuBusy !== undefined).map((s) => s.gpuBusy)) : null,
    cpWork: avg(sec.map((s) => s.cpWork)),
    perSecond: {
      pipeCompileMs: sum('pipeCompileMs') / sec.length, pipeStallMs: sum('pipeStallMs') / sec.length,
      pipeSkipped: sum('pipeSkipped') / sec.length, readbackStallMs: sum('readbackStallMs') / sec.length,
      gpuWaitMs: sum('gpuWaitMs') / sec.length, faults: sum('faults') / sec.length, protectMs: sum('protectMs') / sec.length,
    },
    draws: avg(sec.map((s) => s.draws || 0)),
    slowFrames: slow.length,
    slowCauses: (() => {
      const keys = ['shaderMs', 'pipeCompileMs', 'pipeStallMs', 'gpuWaitMs', 'readbackMs', 'protectMs', 'uploadMs', 'imageMs'];
      const tot = Object.fromEntries(keys.map((k) => [k, slow.reduce((x, f) => x + f[k], 0)]));
      return { totalMs: slow.reduce((x, f) => x + f.ms, 0), ...tot };
    })(),
    threads: [...threads].map(([name, e]) => ({ name, avg: avg(e.samples), p90: pctl([...e.samples].sort((a, b) => a - b), 0.9), kernel: avg(e.kernel) }))
      .sort((a, b) => b.avg - a.avg).slice(0, 8),
    profiles: Object.fromEntries([...profiles].map(([t, p]) => {
      const total = [...p.values()].reduce((x, y) => x + y, 0);
      return [t, [...p].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => [k, 100 * v / total])];
    })),
    readbackCode: [...readbackCode].sort((a, b) => b[1] - a[1]).slice(0, 5),
    // Hitches: slow frames grouped by the second they happened in, with their main cause.
    hitches: (() => {
      const bySecond = new Map();
      for (const f of slow) {
        const h = bySecond.get(f.at) || { at: f.at, frames: 0, ms: 0, causes: {} };
        h.frames++; h.ms += f.ms;
        const causes = { 'shader translation': f.shaderMs, 'pipeline compile': f.pipeCompileMs + f.pipeStallMs,
          'GPU readback': f.readbackMs, 'GPU wait': f.gpuWaitMs, 'uploads': f.uploadMs + f.imageMs, 'page protection': f.protectMs };
        for (const [k, v] of Object.entries(causes)) h.causes[k] = (h.causes[k] || 0) + v;
        bySecond.set(f.at, h);
      }
      return [...bySecond.values()].map((h) => {
        const known = Object.values(h.causes).reduce((x, y) => x + y, 0);
        const top = Object.entries(h.causes).sort((a, b) => b[1] - a[1])[0];
        const s = all[h.at];
        return { ...h, cause: top && top[1] > 0.2 * h.ms ? top[0] : (known < 0.2 * h.ms ? 'game / emulator CPU work (not GPU-side)' : 'mixed'),
          pipelines: s?.pipelines ?? 0 };
      });
    })(),
  };
  // Share of the profile samples of a thread spent blocked in the kernel (waiting, not working).
  const waitShare = (t) => (out.profiles[t] || []).filter(([k]) => /ZwWait|NtWait|WaitForAlert|ZwDelayExecution/.test(k))
    .reduce((x, [, v]) => x + v, 0);
  out.mainWaitShare = waitShare('Game:Main');
  out.verdict = verdict(out);
  if (crash) out.verdict.unshift(crash);
  return out;
}

function verdict(s) {
  const v = [];
  const main = s.threads.find((t) => t.name === 'Game:Main');
  const cp = s.threads.find((t) => t.name === 'shadPS4:GpuCommandProcessor');
  if (s.fps.avg >= 58 && s.fps.p5 >= 50) v.push('Smooth: average and 5% low are near 60 fps.');
  if (main && main.p90 >= 90 && s.mainWaitShare < 40) v.push(`CPU bound on the game's main thread (Game:Main ${main.avg.toFixed(0)}% avg, ${main.p90.toFixed(0)}% p90 of one core): the game's own code is the limit - a faster core, or game patches that cut CPU work, help; resolution does not.`);
  if (s.mainWaitShare >= 40) v.push(`The game's main thread is blocked ${s.mainWaitShare.toFixed(0)}% of the sampled time (waiting on the emulator, not computing).`);
  if (s.perSecond.readbackStallMs > 100) {
    const top = s.readbackCode[0];
    const total = s.readbackCode.reduce((x, [, n]) => x + n, 0);
    v.push(`Game threads stall ${s.perSecond.readbackStallMs.toFixed(0)} ms per second on GPU readbacks (readbacks_mode 2 = precise).` +
      (top ? ` ${(100 * top[1] / total).toFixed(0)}% of them come from ${top[0]}: try "ps4kit tune readback_relaxed_sites=${top[0].split('+0x')[1]}" (that code then reads data a frame old).` : ''));
  }
  if (cp && cp.p90 >= 90) v.push(`Emulator GPU thread saturated (GpuCommandProcessor ${cp.avg.toFixed(0)}% avg): translating draw calls is the limit - emulator-side optimizations (perf_tuning) matter here.`);
  if (s.gpuBusy !== null && s.gpuBusy >= 85) v.push(`Host GPU busy ${s.gpuBusy.toFixed(0)}%: lower the render resolution (ps4kit preset 1080p / pro1080).`);
  if (s.gpuBusy !== null && s.gpuBusy < 60) v.push(`Host GPU only ${s.gpuBusy.toFixed(0)}% busy: resolution is not the bottleneck, a higher preset costs little.`);
  const c = s.slowCauses;
  if (s.slowFrames && (c.pipeCompileMs + c.shaderMs + c.pipeStallMs) > 0.3 * c.totalMs) v.push('Stutters mostly from shader/pipeline compilation: they fade as the pipeline cache fills (keep playing the same areas, never delete the cache).');
  if (s.perSecond.protectMs > 50) v.push(`Page protection costs ${s.perSecond.protectMs.toFixed(0)} ms/s.`);
  if (!v.length) v.push('No single dominant bottleneck in this capture.');
  return v;
}

function format(s) {
  if (s.error) return s.error;
  const f1 = (x) => x.toFixed(1), L = [];
  L.push(`Seconds analysed: ${s.seconds} (boot skipped)`);
  L.push(`FPS: avg ${f1(s.fps.avg)} | median ${f1(s.fps.p50)} | 5% low ${f1(s.fps.p5)} | ${(100 * s.fps.below30).toFixed(0)}% of seconds under 30`);
  L.push(`Frames >33 ms: ${s.framesOver33}, >50 ms: ${s.framesOver50}, worst ${f1(s.frameMaxMs)} ms`);
  L.push(`Host GPU busy: ${s.gpuBusy === null ? 'n/a (gpu_profile = 1)' : f1(s.gpuBusy) + '%'} | emulator GPU thread work ${f1(s.cpWork)}% | ${s.draws.toFixed(0)} draws/frame`);
  const p = s.perSecond;
  L.push(`Per second: pipeline compile ${f1(p.pipeCompileMs)} ms, stall ${f1(p.pipeStallMs)} ms, ${f1(p.pipeSkipped)} draws skipped | readback stall ${f1(p.readbackStallMs)} ms | gpu waits ${f1(p.gpuWaitMs)} ms | page faults ${p.faults.toFixed(0)}, protect ${f1(p.protectMs)} ms`);
  const c = s.slowCauses;
  L.push(`Slow frames (>50 ms) logged: ${s.slowFrames}, ${c.totalMs.toFixed(0)} ms total - shaders ${c.shaderMs.toFixed(0)}, pipelines ${(c.pipeCompileMs + c.pipeStallMs).toFixed(0)}, gpu waits ${c.gpuWaitMs.toFixed(0)}, readbacks ${c.readbackMs.toFixed(0)}, uploads ${(c.uploadMs + c.imageMs).toFixed(0)}, protect ${c.protectMs.toFixed(0)} ms`);
  L.push('Busiest threads (% of one core, avg / p90, kernel):');
  for (const t of s.threads) L.push(`  ${t.name.padEnd(34)} ${t.avg.toFixed(0).padStart(3)}% / ${t.p90.toFixed(0).padStart(3)}%  (kernel ${t.kernel.toFixed(0)}%)`);
  for (const [t, rows] of Object.entries(s.profiles)) {
    if (!/Game:Main|GpuCommandProcessor/.test(t)) continue;
    L.push(`Profile ${t}:`);
    for (const [k, v] of rows) L.push(`  ${v.toFixed(1).padStart(5)}%  ${k}`);
  }
  if (s.hitches.length) {
    const fmtT = (t) => `${String(Math.floor(t / 60)).padStart(2, ' ')}:${String(t % 60).padStart(2, '0')}`;
    L.push(`Hitches (seconds with frames over 50 ms): ${s.hitches.length} - worst first`);
    for (const h of [...s.hitches].sort((a, b) => b.ms - a.ms).slice(0, 12)) {
      L.push(`  at ${fmtT(h.at)}  ${String(h.frames).padStart(2)} frame(s) ${h.ms.toFixed(0).padStart(5)} ms  ${h.cause}${h.pipelines ? ` (${h.pipelines} new pipelines that second)` : ''}`);
    }
    const byCause = {};
    for (const h of s.hitches) byCause[h.cause] = (byCause[h.cause] || 0) + h.ms;
    L.push(`  total by cause: ${Object.entries(byCause).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`).join(', ')}`);
  }
  if (s.readbackCode.length) {
    L.push('GPU readbacks by game code:');
    for (const [k, n] of s.readbackCode) L.push(`  ${String(n).padStart(6)} x  ${k}`);
  }
  L.push('', 'Verdict:', ...s.verdict.map((x) => `  - ${x}`));
  return L.join('\n');
}

function reportFile(logPath, opts) {
  return format(summarize(fs.readFileSync(logPath, 'utf8'), opts));
}

module.exports = { parse, summarize, format, reportFile };
