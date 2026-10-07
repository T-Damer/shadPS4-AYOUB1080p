#!/usr/bin/env node
// ps4kit - helpers for running PS4 dumps with shadPS4 (built around inFAMOUS Second Son).
// Usage: node ps4kit.js <command> [args]   (node ps4kit.js help)
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { openInner } = require('./lib/pfs');
const { PkgTool, pkgSfo, sceSysPath } = require('./lib/pkg');
const perf = require('./lib/perf');

const HERE = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'ps4kit.json'), 'utf8'));
const pkgtool = () => new PkgTool(path.resolve(HERE, cfg.pkgtool));
const GB = (n) => `${(n / 1e9).toFixed(2)} GB`;

function args(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') && ['to', 'skip', 'log', 'build', 'seconds'].includes(k) ? argv[++i] : true);
    } else pos.push(a);
  }
  return { pos, flags };
}

/** Where a PKG goes: game -> <gamesDir>/<TITLE>, patch -> <TITLE>-patch, DLC -> addcont. */
function destFor(sfo, gamesDir) {
  const cat = sfo.CATEGORY || '';
  if (cat.startsWith('gd')) return path.join(gamesDir, sfo.TITLE_ID);
  if (cat === 'gp') return path.join(gamesDir, `${sfo.TITLE_ID}-patch`);
  if (cat === 'ac') return path.join(cfg.userDir, 'addcont', sfo.TITLE_ID, sfo.CONTENT_ID.split('-').pop());
  throw new Error(`unknown PKG category "${cat}"`);
}

function describe(sfo) {
  const kind = { gd: 'game', gp: 'update', ac: 'DLC' }[sfo.CATEGORY?.slice(0, 2)] || sfo.CATEGORY;
  return `${sfo.TITLE} [${sfo.TITLE_ID}] ${kind} v${sfo.APP_VER || sfo.VERSION}`;
}

async function writeFile(pfs, ino, outPath) {
  const src = pfs.content(ino);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const fd = fs.openSync(outPath, 'w');
  try {
    for (let pos = 0; pos < src.size; pos += 8 << 20) {
      const n = Math.min(8 << 20, src.size - pos);
      fs.writeSync(fd, src.read(pos, n), 0, n, pos);
    }
  } finally { fs.closeSync(fd); }
  return src.size;
}

/** Decrypts the outer PFS next to `dest` (same drive), runs fn(innerPfs), deletes the temp. */
async function withInner(pkg, dest, fn) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.ps4kit-${path.basename(dest)}.pfs`);
  const need = fs.statSync(pkg).size;
  console.log(`Decrypting the content image (${GB(need)} temporary file: ${tmp})...`);
  pkgtool().extractOuterPfs(pkg, tmp);
  const inner = openInner(tmp);
  try { return await fn(inner.pfs); } finally { inner.close(); fs.rmSync(tmp, { force: true }); }
}

const commands = {
  async info({ pos }) {
    for (const pkg of pos) {
      const sfo = pkgSfo(pkg);
      console.log(`${pkg}\n  ${describe(sfo)}\n  content ${sfo.CONTENT_ID}  ->  ${destFor(sfo, cfg.gamesDir)}`);
    }
  },

  async extract({ pos, flags }) {
    if (!pos.length) throw new Error('usage: extract <pkg>... [--to <gamesDir>]');
    for (const pkg of pos) {
      const sfo = pkgSfo(pkg);
      const dest = destFor(sfo, flags.to || cfg.gamesDir);
      console.log(`\n${describe(sfo)}\n  -> ${dest}`);
      if (fs.existsSync(path.join(dest, 'eboot.bin')) && !flags.force) {
        console.log('  already extracted (eboot.bin present) - use --force to extract again, or verify it.');
        continue;
      }
      let entries;
      try { entries = pkgtool().entries(pkg); } catch (e) { throw new Error(`PkgTool cannot read ${pkg}: ${e.message}`); }
      await withInner(pkg, dest, async (pfs) => {
        const files = pfs.files();
        let bytes = 0, done = 0;
        for (const f of files) {
          bytes += await writeFile(pfs, f.ino, path.join(dest, f.path));
          if (++done % 100 === 0) console.log(`  ${done}/${files.length} files, ${GB(bytes)}`);
        }
        console.log(`  ${files.length} files, ${GB(bytes)}`);
      });
      // Metadata outside the image (npbind, playgo, trophies...) goes to sce_sys.
      let meta = 0;
      for (const e of entries) {
        const rel = sceSysPath(e.name);
        if (!rel) continue;
        const out = path.join(dest, 'sce_sys', rel);
        if (fs.existsSync(out)) continue;
        try { pkgtool().extractEntry(pkg, e.index, out); meta++; } catch { console.log(`  (could not extract ${e.name})`); }
      }
      const sfoOut = path.join(dest, 'sce_sys', 'param.sfo');
      if (!fs.existsSync(sfoOut)) {
        const sfoEntry = entries.find((e) => e.name === 'PARAM_SFO');
        if (sfoEntry) { pkgtool().extractEntry(pkg, sfoEntry.index, sfoOut); meta++; }
      }
      console.log(`  ${meta} metadata files added to sce_sys`);
    }
  },

  async verify({ pos, flags }) {
    const [pkg, dirArg] = pos;
    if (!pkg) throw new Error('usage: verify <pkg> [extractedDir] [--deep]');
    const sfo = pkgSfo(pkg);
    const dir = dirArg || destFor(sfo, cfg.gamesDir);
    console.log(`${describe(sfo)}\n  checking ${dir}${flags.deep ? ' (contents too, slow)' : ''}`);
    await withInner(pkg, dir, async (pfs) => {
      let missing = 0, wrongSize = 0, different = 0, ok = 0;
      for (const f of pfs.files()) {
        const p = path.join(dir, f.path);
        const src = pfs.content(f.ino);
        if (!fs.existsSync(p)) { missing++; if (missing <= 10) console.log(`  missing   ${f.path}`); continue; }
        if (fs.statSync(p).size !== src.size) { wrongSize++; if (wrongSize <= 10) console.log(`  size diff ${f.path}`); continue; }
        if (flags.deep) {
          const fd = fs.openSync(p, 'r');
          let same = true;
          for (let pos = 0; pos < src.size && same; pos += 8 << 20) {
            const n = Math.min(8 << 20, src.size - pos), b = Buffer.alloc(n);
            fs.readSync(fd, b, 0, n, pos);
            same = b.equals(src.read(pos, n));
          }
          fs.closeSync(fd);
          if (!same) { different++; if (different <= 10) console.log(`  content   ${f.path}`); continue; }
        }
        ok++;
      }
      console.log(`  ok ${ok}, missing ${missing}, wrong size ${wrongSize}${flags.deep ? `, different content ${different}` : ''}`);
      if (missing + wrongSize + different) process.exitCode = 1;
    });
  },

  async preset({ pos }) {
    const PRESETS = {
      '1080p': { neo: false, on: [] },
      '1440p': { neo: false, on: ['Native 2560x1440 (render and output)'] },
      '2160p': { neo: false, on: ['Native 3840x2160 (render and output)'] },
      pro1080: { neo: true, on: [] },
      pro1440: { neo: true, on: ['PS4 Pro mode: native 2560x1440 without checkerboard'] },
      pro1800: { neo: true, on: ['PS4 Pro mode: native 3200x1800 without checkerboard'] },
      pro2160: { neo: true, on: ['PS4 Pro mode: native 3840x2160 without checkerboard'] },
      // 21:9 (3456x1440), patches added by ps4kit to the fork's patch file
      ultrawide: { neo: false, on: ['Ultrawide 3456x1440 21:9 (render and output)'] },
      'pro-ultrawide': { neo: true, on: ['PS4 Pro mode: ultrawide 3456x1440 21:9 without checkerboard'] },
      uw1080: { neo: false, on: ['Ultrawide 2560x1080 21:9 (render and output)'] },
      'pro-uw1080': { neo: true, on: ['PS4 Pro mode: ultrawide 2560x1080 21:9 without checkerboard'] },
    };
    const RES = Object.values(PRESETS).flatMap((p) => p.on);
    const xmlPath = path.join(cfg.userDir, cfg.patchFile);
    const cfgPath = path.join(cfg.userDir, 'custom_configs', `${cfg.titleId}.json`);
    let xml = fs.readFileSync(xmlPath, 'utf8');
    const game = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const enabled = (name) => new RegExp(`Name="${name.replace(/[()]/g, '\\$&')}"[^>]*isEnabled="true"`).test(xml);
    const current = Object.entries(PRESETS).find(([, p]) => p.neo === !!game.General?.neo_mode &&
      RES.every((r) => enabled(r) === p.on.includes(r)))?.[0] || 'custom';
    if (!pos[0]) {
      console.log(`Current: ${current}\nAvailable: ${Object.keys(PRESETS).join(', ')}`);
      console.log('  1080p/1440p/2160p: base PS4 mode at that resolution (lighter)');
      console.log('  pro*: PS4 Pro mode (extra Pro effects) at that resolution');
      console.log('  ultrawide / pro-ultrawide: 21:9 at 3456x1440, uw1080 / pro-uw1080: 21:9 at 2560x1080 (experimental)');
      return;
    }
    const p = PRESETS[pos[0]];
    if (!p) throw new Error(`unknown preset ${pos[0]}`);
    for (const r of RES) {
      const re = new RegExp(`(Name="${r.replace(/[()]/g, '\\$&')}"[^>]*isEnabled=")(true|false)"`);
      xml = xml.replace(re, `$1${p.on.includes(r)}"`);
    }
    fs.writeFileSync(xmlPath, xml);
    game.General = { ...game.General, neo_mode: p.neo };
    fs.writeFileSync(cfgPath, JSON.stringify(game, null, 4) + '\n');
    console.log(`Preset ${pos[0]} set (was ${current}). It applies at the next launch.`);
  },

  async launch({ flags }) {
    const build = flags.build || (flags.dev ? 'dev' : cfg.defaultBuild);
    const exe = cfg.builds[build];
    if (!exe || !fs.existsSync(exe)) throw new Error(`build "${build}" not found (${exe}); builds: ${Object.keys(cfg.builds).join(', ')}`);
    const eboot = path.join(cfg.gamesDir, cfg.titleId, 'eboot.bin');
    setTuning({ perf_log: flags.perf ? 1 : 0, gpu_profile: flags.perf ? 1 : 0 });
    const child = spawn(exe, ['-g', eboot], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`Started ${exe}${flags.perf ? ' with performance logging' : ''}.`);
    if (flags.perf) console.log('Play a few minutes in the area that lags, quit the game, then: node ps4kit.js perf');
  },

  async perf({ pos, flags }) {
    const log = pos[0] || path.join(cfg.userDir, 'log', 'shad_log.txt');
    const text = fs.readFileSync(log, 'utf8');
    const report = perf.format(perf.summarize(text, { skipSeconds: Number(flags.skip ?? 20) }));
    console.log(report);
    if (!pos[0] && /Perf: [\d.]+ fps/.test(text)) {
      const dir = path.join(HERE, 'perf-logs');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date(fs.statSync(log).mtime).toISOString().replace(/[:T]/g, '-').slice(0, 16);
      fs.copyFileSync(log, path.join(dir, `${stamp}-shad_log.txt`));
      fs.writeFileSync(path.join(dir, `${stamp}-report.txt`), report + '\n');
      console.log(`\nSaved to perf-logs/${stamp}-*`);
    }
  },

  /**
   * Live A/B test in the running game: applies each variant of perf_tuning.ini for a while and
   * compares fps and the load of the emulator's GPU thread. Stand still in a busy place.
   */
  async abtest({ flags }) {
    const variants = [
      ['baseline', {}],
      ['scout', { scout: 1 }],
      ['scout+fast', { scout: 1, scout_fast: 1 }],
      ['gpu priority', { gpu_threads_priority: 2 }],
      ['hot pages', { hot_page_faults: 8 }],
      ['asc queue', { asc_queue: 1 }],
      ['baseline again', {}],
    ];
    const seconds = Number(flags.seconds || 25);
    const log = path.join(cfg.userDir, 'log', 'shad_log.txt');
    const saved = readTuning();
    const reset = { scout: 0, scout_fast: 0, gpu_threads_priority: 0, hot_page_faults: 0, asc_queue: 0 };
    const rows = [];
    console.log(`A/B test: ${variants.length} variants x ${seconds + 5} s. Keep the camera still.`);
    try {
      for (const [name, kv] of variants) {
        setTuning({ perf_log: 1, ...reset, ...kv });
        await new Promise((r) => setTimeout(r, 5000)); // settle
        const start = fs.statSync(log).size;
        await new Promise((r) => setTimeout(r, seconds * 1000));
        const fd = fs.openSync(log, 'r');
        const len = fs.statSync(log).size - start;
        const buf = Buffer.alloc(Math.max(0, len));
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        const { seconds: secs, threads } = perf.parse(buf.toString('utf8'));
        const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
        const cp = threads.get('shadPS4:GpuCommandProcessor');
        const row = { name, fps: avg(secs.map((s) => s.fps)), work: avg(secs.map((s) => s.cpWork)), cp: cp ? avg(cp.samples) : NaN, over33: secs.reduce((x, s) => x + s.over33, 0) };
        rows.push(row);
        console.log(`  ${name.padEnd(16)} ${row.fps.toFixed(1).padStart(5)} fps  GPU thread work ${row.work.toFixed(0).padStart(3)}%  CPU ${row.cp.toFixed(0).padStart(3)}%  frames>33ms ${row.over33}`);
      }
    } finally {
      fs.writeFileSync(tuningPath(), saved ? saved + '\n' : '');
      console.log('perf_tuning.ini restored.');
    }
  },

  /** Emulated display refresh: the game can present at most this many frames per second. */
  async fps({ pos }) {
    const game = readGameConfig();
    if (!pos[0]) { console.log(`vblank_frequency: ${game.GPU?.vblank_frequency ?? '60 (default)'}`); return; }
    const hz = Number(pos[0]);
    if (!(hz >= 30 && hz <= 240)) throw new Error('usage: fps <30-240>');
    game.GPU = { ...game.GPU, vblank_frequency: hz };
    writeGameConfig(game);
    console.log(`Frame rate cap set to ${hz} (vblank_frequency), applies at the next launch.` +
      (hz > 60 ? ' Experimental: if the game runs too fast (movement, timers), go back to 60.' : ''));
  },

  /** FPS counter overlay (also toggled in game with F10). */
  async overlay({ pos }) {
    // Not overridable per game: global config.json (Big Picture rewrites it when it exits, so
    // change it while Big Picture is closed).
    const p = path.join(cfg.userDir, 'config.json');
    const global = JSON.parse(fs.readFileSync(p, 'utf8'));
    const on = pos[0] !== 'off';
    global.General = { ...global.General, show_fps_counter: on };
    fs.writeFileSync(p, JSON.stringify(global, null, 2) + '\n');
    const game = readGameConfig();
    if (game.General?.show_fps_counter !== undefined) { delete game.General.show_fps_counter; writeGameConfig(game); }
    console.log(`FPS overlay ${on ? 'on' : 'off'} from the next launch (F10 toggles it in game).`);
  },

  /** Unattended run from boot: launch, wait, quit, keep the log, print the summary. */
  async bench({ pos, flags }) {
    const name = pos[0];
    if (!name) throw new Error('usage: bench <name> [--build b] [--seconds 180] [key=value]...');
    const build = flags.build || cfg.defaultBuild, exe = cfg.builds[build];
    const seconds = Number(flags.seconds || 180);
    const saved = readTuning();
    const kv = Object.fromEntries(pos.slice(1).map((s) => s.split('=').map((x) => x.trim())));
    setTuning({ perf_log: 1, gpu_profile: 1, ...kv });
    console.log(`bench ${name}: ${build} build, ${seconds} s, ${JSON.stringify(kv)}`);
    const child = spawn(exe, ['-g', path.join(cfg.gamesDir, cfg.titleId, 'eboot.bin')], { cwd: path.dirname(exe), stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, seconds * 1000));
    child.kill();
    await new Promise((r) => setTimeout(r, 4000));
    fs.writeFileSync(tuningPath(), saved ? saved + '\n' : '');
    const dir = path.join(HERE, 'perf-logs');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `bench-${name}.txt`);
    fs.copyFileSync(path.join(cfg.userDir, 'log', 'shad_log.txt'), out);
    console.log(perf.format(perf.summarize(fs.readFileSync(out, 'utf8'))));
  },

  async tune({ pos }) {
    if (!pos.length) { console.log(readTuning() || '(perf_tuning.ini is empty)'); return; }
    const kv = Object.fromEntries(pos.map((s) => s.split('=').map((x) => x.trim())));
    setTuning(kv);
    console.log(readTuning());
  },

  async status() {
    for (const [name, exe] of Object.entries(cfg.builds)) {
      console.log(`Build ${name.padEnd(8)} ${exe}${fs.existsSync(exe) ? '' : '  (not built)'}${name === cfg.defaultBuild ? '  [default]' : ''}`);
    }
    console.log(`User folder:  ${cfg.userDir}\nGame:         ${path.join(cfg.gamesDir, cfg.titleId)}`);
    for (const d of [cfg.titleId, `${cfg.titleId}-patch`]) {
      const sfoPath = path.join(cfg.gamesDir, d, 'sce_sys', 'param.sfo');
      if (fs.existsSync(sfoPath)) console.log(`  ${d}: v${require('./lib/pkg').parseSfo(fs.readFileSync(sfoPath)).APP_VER}`);
    }
    const cache = path.join(cfg.userDir, 'cache', cfg.titleId);
    if (fs.existsSync(cache)) {
      const size = fs.readdirSync(cache, { recursive: true }).reduce((s, f) => {
        const st = fs.statSync(path.join(cache, f));
        return s + (st.isFile() ? st.size : 0);
      }, 0);
      console.log(`Pipeline cache: ${(size / 1e6).toFixed(0)} MB (grows as new effects compile; never delete it)`);
    }
    await commands.preset({ pos: [] });
    console.log(`perf_tuning.ini:\n${readTuning() || '  (empty)'}`);
  },

  async help() {
    console.log(`ps4kit - shadPS4 helpers (config: ps4kit.json)

  info <pkg>...                 what a PKG is and where it extracts to
  extract <pkg>... [--to dir]   extract game / update / DLC PKGs (correctly - see README)
  verify <pkg> [dir] [--deep]   compare an extracted folder with its PKG
  preset [name]                 show or set the resolution preset
  launch [--perf] [--build b]   start the game (--perf: performance logging; b: own, release, fresh)
  fps [hz]                      show or set the frame rate cap (emulated refresh, default 60)
  overlay [on|off]              FPS counter overlay (F10 in game)
  perf [log] [--skip N]         summarise the performance logging of the last session
  bench <name> [--build b] [--seconds 180] [key=value]...
                                unattended run from boot with these settings, then its summary
  tune [key=value]...           show or change perf_tuning.ini (applies while the game runs)
  abtest [--seconds 25]         live A/B of speed options in the running game (stand still)
  status                        paths, versions, preset, cache size`);
  },
};

function gameConfigPath() { return path.join(cfg.userDir, 'custom_configs', `${cfg.titleId}.json`); }
function readGameConfig() { return fs.existsSync(gameConfigPath()) ? JSON.parse(fs.readFileSync(gameConfigPath(), 'utf8')) : {}; }
function writeGameConfig(c) { fs.writeFileSync(gameConfigPath(), JSON.stringify(c, null, 4) + '\n'); }

function tuningPath() { return path.join(cfg.userDir, 'perf_tuning.ini'); }
function readTuning() { return fs.existsSync(tuningPath()) ? fs.readFileSync(tuningPath(), 'utf8').trim() : ''; }
function setTuning(kv) {
  const lines = readTuning().split(/\r?\n/).filter(Boolean);
  for (const [k, v] of Object.entries(kv)) {
    const i = lines.findIndex((l) => l.split('=')[0].trim() === k);
    const line = `${k} = ${v}`;
    if (i >= 0) lines[i] = line; else lines.push(line);
  }
  fs.writeFileSync(tuningPath(), lines.join('\n') + '\n');
}

const [cmd = 'help', ...rest] = process.argv.slice(2);
(commands[cmd] || commands.help)(args(rest)).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
