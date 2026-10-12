// DataPro web core: data model, file parsers and processing.
// Ported from "datapro 20260916.py"; every function mirrors the desktop one named in its comment.
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- tables
  // A table is {columns: string[], data: {col: array}}; numeric columns hold numbers (NaN for missing).

  function nrows(t) {
    return t.columns.length ? t.data[t.columns[0]].length : 0;
  }

  function makeTable(columns, colArrays) {
    const data = {};
    columns.forEach((c, i) => { data[c] = colArrays[i]; });
    return { columns: columns.slice(), data };
  }

  function cloneTable(t) {
    const data = {};
    t.columns.forEach(c => { data[c] = t.data[c].slice(); });
    return { columns: t.columns.slice(), data };
  }

  function takeRows(t, idx) {
    const data = {};
    t.columns.forEach(c => { const a = t.data[c]; data[c] = idx.map(i => a[i]); });
    return { columns: t.columns.slice(), data };
  }

  function sliceRows(t, start, end) {
    const data = {};
    t.columns.forEach(c => { data[c] = t.data[c].slice(start, end); });
    return { columns: t.columns.slice(), data };
  }

  // pd.to_numeric(errors='coerce') for one value
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === null || v === undefined) return NaN;
    const s = String(v).trim();
    if (s === '') return NaN;
    const l = s.toLowerCase();
    if (l === 'nan' || l === 'na' || l === 'null' || l === 'none') return NaN;
    if (l === 'inf' || l === '+inf' || l === 'infinity' || l === '+infinity') return Infinity;
    if (l === '-inf' || l === '-infinity') return -Infinity;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
    return Number(s);
  }

  function isMissing(v) {
    return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
  }

  // df.dropna(axis=1, how='all') then df.dropna(how='all')
  function dropAllNa(t, missing = isMissing) {
    const cols = t.columns.filter(c => !t.data[c].every(missing));
    const n = nrows(t);
    const keep = [];
    for (let i = 0; i < n; i++) if (!cols.every(c => missing(t.data[c][i]))) keep.push(i);
    return takeRows({ columns: cols, data: t.data }, keep);
  }

  function dedupeColumns(cols) {
    const seen = {};
    return cols.map(c => {
      if (!(c in seen)) { seen[c] = 0; return c; }
      let k = ++seen[c];
      while ((c + '.' + k) in seen) k++;
      seen[c + '.' + k] = 0;
      return c + '.' + k;
    });
  }

  // --------------------------------------------------------- text loading
  const COLUMN_INDICATORS = ['outputv', 'time', 'temp', 'volt', 'current', 'b', 't1', 't2', 'i', 'x1',
    'angle', 'hall', 'gate', 'leak'];

  function splitFields(line) {
    return line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/).filter(Boolean);
  }

  // detect_data_structure
  function detectDataStructure(rawLines, maxCheckRows = 10) {
    const lines = rawLines.slice(0, maxCheckRows).map(l => l.trim());
    let header = null, headerIdx = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const parts = splitFields(line);
      if (parts.length < 3) continue;
      const low = line.toLowerCase();
      if (['am', 'pm', 'frequency', 'stop at', 'hz', 'db/oct'].some(k => low.includes(k))) continue;
      let valid = 0;
      for (const part of parts) {
        const p = part.toLowerCase().trim();
        if (COLUMN_INDICATORS.some(ind => p.includes(ind))) valid++;
        else if (p.length <= 10 && p.length > 0 && /^\p{L}+$/u.test(p)) valid++;
        else if (p.length <= 8 && /\p{L}/u.test(p) && /\d/.test(p)) valid++;
      }
      if (valid >= parts.length * 0.7 && parts.length > 5) { header = parts; headerIdx = i; break; }
    }
    if (!header) return null;
    const cols = header.map(c => c.trim()).filter(Boolean);
    let start = headerIdx + 1;
    while (start < lines.length) {
      const line = lines[start];
      if (!line) { start++; continue; }
      const parts = splitFields(line);
      if (parts.length === cols.length) {
        let matches = 0;
        parts.forEach((p, i) => { if (i < cols.length && p.trim().toLowerCase() === cols[i].toLowerCase()) matches++; });
        if (matches >= cols.length * 0.8) { start++; continue; }
      }
      const numeric = parts.filter(p => !Number.isNaN(toNum(p)) || /^[+-]?(nan|inf)/i.test(p.trim())).length;
      if (numeric >= parts.length * 0.5) break;
      start++;
    }
    return { columns: cols, dataStart: start };
  }

  // raw=true keeps the strings, as pd.read_csv does before pd.to_numeric
  function rowsToTable(columns, rows, raw = false) {
    let width = 0;
    for (const r of rows) if (r.length > width) width = r.length;
    let cols = columns;
    let used = width;
    if (cols.length <= width) used = cols.length;
    else cols = cols.slice(0, width);
    const arrays = cols.map(() => []);
    for (const r of rows) for (let j = 0; j < used; j++) arrays[j].push(raw ? (r[j] === undefined ? '' : r[j]) : toNum(r[j]));
    return makeTable(dedupeColumns(cols), arrays);
  }

  // pandas' default NA strings
  const NA_STRINGS = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN',
    '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null']);
  const isRawMissing = v => (typeof v === 'string' ? NA_STRINGS.has(v.trim()) : isMissing(v));

  // csv.Sniffer-style fallback used by pd.read_csv(sep=None)
  function sniffDelimited(lines) {
    const body = lines.filter(l => l.trim() !== '');
    if (!body.length) return null;
    const sample = body.slice(0, 20);
    let best = null;
    for (const d of [',', '\t', ';', '|']) {
      const counts = sample.map(l => l.split(d).length - 1);
      if (counts[0] > 0 && counts.every(c => c === counts[0])) { best = d; break; }
    }
    const split = best ? (l => l.split(best).map(s => s.trim().replace(/^"(.*)"$/, '$1'))) : (l => l.trim().split(/\s+/));
    const header = split(body[0]).map(s => s.trim());
    const rows = body.slice(1).map(split);
    return rowsToTable(header.map((h, i) => h || 'Unnamed: ' + i), rows, true);
  }

  // load_text_file
  function parseTextFile(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    const det = detectDataStructure(lines);
    let t;
    if (det) {
      const sample = lines[det.dataStart] || '';
      const tab = sample.includes('\t');
      const rows = [];
      for (let i = det.dataStart; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() === '') continue;
        rows.push(tab ? l.split('\t') : l.trim().split(/\s+/));
      }
      t = rowsToTable(det.columns, rows, true);
    } else {
      t = sniffDelimited(lines);
      if (!t) throw new Error('文件里没有可读的数据行');
    }
    t = dropAllNa(t, isRawMissing);
    const clean = dedupeColumns(t.columns.map(c => String(c).trim()));
    return makeTable(clean, t.columns.map(c => t.data[c].map(toNum)));
  }

  // load_hk_file -> {runs: [{name, table}], skipped}
  function parseHkFile(text) {
    const all = text.replace(/^﻿/, '').split(/\r?\n/);
    const runNames = [];
    let dataStart = null;
    for (let i = 0; i < all.length; i++) {
      const s = all[i].trim();
      if (s === 'Below is data') { dataStart = i + 1; break; }
      if (s) runNames.push(s.split('\t')[0].trim());
    }
    if (dataStart === null) throw new Error("没有找到 'Below is data' 标记，不是 HK 文件");
    const blocks = [];
    let cur = [], inBlock = false;
    for (let i = dataStart; i < all.length; i++) {
      const line = all[i], s = line.trim();
      if (s.startsWith('GAPComment:')) {
        if (cur.length) blocks.push(cur);
        cur = ['Comment:' + s.slice('GAPComment:'.length)]; inBlock = true;
      } else if (s.startsWith('Comment:')) {
        if (cur.length) blocks.push(cur);
        cur = [line]; inBlock = true;
      } else if (s === 'GAP') {
        if (cur.length) { blocks.push(cur); cur = []; }
        inBlock = false;
      } else if (inBlock) cur.push(line);
    }
    if (cur.length) blocks.push(cur);
    if (!blocks.length) throw new Error('HK 文件里没有数据块');

    const runs = [];
    let skipped = 0;
    blocks.forEach((block, bi) => {
      const runName = bi < runNames.length ? runNames[bi] : 'run_' + (bi + 1);
      let header = null;
      const rows = [];
      for (const line of block) {
        const s = line.trim();
        if (s.startsWith('Header:')) header = s.slice(7).trim().split('\t').map(c => c.trim()).filter(Boolean);
        else if (s.startsWith('Data:')) rows.push(s.slice(5).trim().split('\t'));
        else if (header && s && !s.startsWith('Comment:')) {
          const parts = s.split('\t');
          if (parts.length >= 2) rows.push(parts);
        }
      }
      if (!header || !rows.length) { skipped++; return; }
      let t = rowsToTable(header, rows);
      const n = nrows(t), keep = [];
      for (let i = 0; i < n; i++) if (!t.columns.every(c => isMissing(t.data[c][i]))) keep.push(i);
      t = takeRows(t, keep);
      let display = 'run_' + (bi + 1);
      const parts = runName.split(/\s+/);
      for (let j = 0; j < parts.length; j++) {
        const p = parts[j];
        if (p.includes('-') && p.length >= 8 && /\d/.test(p)) {
          const tp = parts.slice(j).filter(q => q.includes('-') && /\d/.test(q));
          display = tp.length >= 2 ? `run_${bi + 1} (${tp[0]} ${tp[1]})` : `run_${bi + 1} (${tp[0]})`;
          break;
        }
      }
      runs.push({ name: display, table: t });
    });
    return { runs, skipped, blocks: blocks.length };
  }

  // ------------------------------------------------------------- HDF5 read
  // pandas/PyTables keep column lists as protocol-0 pickles: (lp0\nVname\np1\naV...
  function parsePickledStrList(s) {
    if (typeof s !== 'string') return null;
    const out = [];
    for (const m of s.matchAll(/(?:^|\n)[(at]*V([^\n]*)/g))
      out.push(m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\\\/g, '\\'));
    return out;
  }

  function attr(node, name) {
    try { const a = node.attrs[name]; return a ? a.value : undefined; } catch (e) { return undefined; }
  }

  function plainValue(v) {
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'string') return v.replace(/\0+$/, '');
    return v;
  }

  // pandas format='table' frame stored in group g
  function readPandasTable(g) {
    const t = g.get('table');
    const rows = t.value;
    const fields = t.dtype.map(d => d[0]);
    const cols = {};
    fields.forEach((fname, fi) => {
      if (fname === 'index') return;
      const names = parsePickledStrList(attr(t, fname + '_kind')) || [fname];
      names.forEach((n, j) => {
        cols[n] = rows.map(r => {
          const cell = r[fi];
          return plainValue(Array.isArray(cell) || ArrayBuffer.isView(cell) ? cell[j] : cell);
        });
      });
    });
    const order = parsePickledStrList(attr(g, 'non_index_axes')) || Object.keys(cols);
    const columns = order.filter(c => c in cols);
    Object.keys(cols).forEach(c => { if (!columns.includes(c)) columns.push(c); });
    return makeTable(columns, columns.map(c => cols[c]));
  }

  function datasetStrings(ds) {
    return Array.from(ds.value, v => String(plainValue(v)));
  }

  // pandas format='fixed' frame stored in group g
  function readPandasFixed(g) {
    const columns = datasetStrings(g.get('axis0'));
    const n = g.get('axis1').shape[0];
    const nblocks = Number(attr(g, 'nblocks') || 0);
    const cols = {};
    for (let b = 0; b < nblocks; b++) {
      const items = datasetStrings(g.get(`block${b}_items`));
      const vds = g.get(`block${b}_values`);
      const flat = Array.from(vds.value, plainValue);
      const shape = vds.shape;
      // stored as (rows, items); "transposed" layout stores (items, rows)
      const rowMajor = shape.length === 2 && shape[0] === n && shape[1] === items.length;
      items.forEach((it, j) => {
        const a = new Array(n);
        for (let i = 0; i < n; i++) a[i] = rowMajor ? flat[i * items.length + j] : flat[j * n + i];
        cols[it] = a;
      });
    }
    const cs = columns.filter(c => c in cols);
    return makeTable(cs, cs.map(c => cols[c]));
  }

  function readPandasGroup(g) {
    const kind = attr(g, 'pandas_type');
    if (kind === 'frame_table') return readPandasTable(g);
    if (kind === 'frame') return readPandasFixed(g);
    if (g.keys().includes('table')) return readPandasTable(g);
    throw new Error('不支持的 pandas 存储格式: ' + kind);
  }

  // all pandas objects in the file, keyed like HDFStore.keys()
  function hdfStoreKeys(f) {
    const out = [];
    (function walk(g, path) {
      for (const k of g.keys()) {
        const child = g.get(k);
        if (!child || child.type !== 'Group') continue;
        const p = path + '/' + k;
        if (attr(child, 'pandas_type') !== undefined) out.push(p);
        else walk(child, p);
      }
    })(f, '');
    return out;
  }

  // load_hdf5_file -> list of {name, isFolder, parent, table} in insertion order
  function readHdfProject(f, fileBaseName) {
    const keys = hdfStoreKeys(f);
    const items = [];
    if (keys.includes('/__metadata__')) {
      const m = readPandasGroup(f.get('__metadata__'));
      const n = nrows(m);
      const rows = [];
      for (let i = 0; i < n; i++) {
        const r = {};
        m.columns.forEach(c => { r[c] = m.data[c][i]; });
        r.depth = String(r.path).split('/').length;
        r.i = i;
        rows.push(r);
      }
      const hasOrder = m.columns.includes('order');
      rows.sort((a, b) => a.depth - b.depth || (hasOrder ? a.order - b.order : 0) || a.i - b.i);
      for (const r of rows) {
        const parent = r.parent_folder ? String(r.parent_folder) : null;
        if (r.is_folder === true || r.is_folder === 1) {
          items.push({ name: String(r.name), isFolder: true, parent });
        } else {
          const safe = String(r.path).replace(/\\/g, '/').split('/').join('__').split('.').join('_').split(' ').join('_');
          const key = '/data/' + safe;
          if (keys.includes(key)) items.push({ name: String(r.name), isFolder: false, parent, table: readPandasGroup(f.get(key.slice(1))) });
        }
      }
      return { structured: true, items };
    }
    items.push({ name: fileBaseName, isFolder: true, parent: null });
    for (const k of keys) {
      if (k.startsWith('/_metadata')) continue;
      items.push({ name: k.replace(/^\/+|\/+$/g, ''), isFolder: false, parent: fileBaseName, table: readPandasGroup(f.get(k.slice(1))) });
    }
    return { structured: false, items };
  }

  // ---------------------------------------------------------- interpolation
  function argsortStable(x) {
    return x.map((v, i) => i).sort((a, b) => (x[a] - x[b]) || (a - b));
  }

  function linspace(a, b, n) {
    if (n <= 0) return [];
    if (n === 1) return [a];
    const out = new Array(n), step = (b - a) / (n - 1);
    for (let i = 0; i < n; i++) out[i] = a + i * step;
    out[n - 1] = b;
    return out;
  }

  function searchsortedRight(a, v) {
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= v) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // scipy.interpolate.interp1d(kind='linear', bounds_error=False, fill_value=0);
  // scipy delegates this case to numpy.interp and fills out-of-bounds points afterwards
  function makeLinear(xIn, yIn) {
    const ord = argsortStable(xIn);
    const x = ord.map(i => xIn[i]), y = ord.map(i => yIn[i]);
    const n = x.length;
    return xn => {
      if (Number.isNaN(xn)) return NaN;
      if (n === 0 || xn < x[0] || xn > x[n - 1]) return 0;
      return npInterp(xn, x, y);
    };
  }

  // scipy.interpolate.interp1d(kind='cubic'): not-a-knot cubic spline; throws where scipy raises
  function makeCubic(xIn, yIn) {
    const ord = argsortStable(xIn);
    const x = ord.map(i => xIn[i]), y = ord.map(i => yIn[i]);
    const n = x.length;
    if (n < 4) throw new Error('cubic needs at least 4 points');
    for (let i = 1; i < n; i++) if (!(x[i] > x[i - 1])) throw new Error('duplicate x');
    const h = [];
    for (let i = 0; i < n - 1; i++) h.push(x[i + 1] - x[i]);
    // interior second-derivative equations: a M[i-1] + b M[i] + c M[i+1] = d, i = 1..n-2
    const a = new Array(n).fill(0), b = new Array(n).fill(0), c = new Array(n).fill(0), d = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      a[i] = h[i - 1]; b[i] = 2 * (h[i - 1] + h[i]); c[i] = h[i];
      d[i] = 6 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]);
    }
    // not-a-knot ends express M[0] and M[n-1] through their neighbours:
    //   M0 = ((h0+h1) M1 - h0 M2) / h1,  M[n-1] = ((h[n-3]+h[n-2]) M[n-2] - h[n-2] M[n-3]) / h[n-3]
    const L1 = (h[0] + h[1]) / h[1], L2 = -h[0] / h[1];
    const R1 = (h[n - 3] + h[n - 2]) / h[n - 3], R2 = -h[n - 2] / h[n - 3];
    b[1] += a[1] * L1; c[1] += a[1] * L2; a[1] = 0;
    b[n - 2] += c[n - 2] * R1; a[n - 2] += c[n - 2] * R2; c[n - 2] = 0;
    // Thomas algorithm on rows 1..n-2 (diagonally dominant after the substitution)
    const cp = new Array(n), dp = new Array(n), M = new Array(n);
    cp[1] = c[1] / b[1]; dp[1] = d[1] / b[1];
    for (let i = 2; i < n - 1; i++) {
      const m = b[i] - a[i] * cp[i - 1];
      cp[i] = c[i] / m; dp[i] = (d[i] - a[i] * dp[i - 1]) / m;
    }
    M[n - 2] = dp[n - 2];
    for (let i = n - 3; i >= 1; i--) M[i] = dp[i] - cp[i] * M[i + 1];
    M[0] = L1 * M[1] + L2 * M[2];
    M[n - 1] = R1 * M[n - 2] + R2 * M[n - 3];
    return xn => {
      if (Number.isNaN(xn)) return NaN;
      if (xn < x[0] || xn > x[n - 1]) return 0;
      let i = searchsortedRight(x, xn) - 1;
      i = Math.min(Math.max(i, 0), n - 2);
      const hi = h[i], A = (x[i + 1] - xn) / hi, B = (xn - x[i]) / hi;
      return A * y[i] + B * y[i + 1] + ((A * A * A - A) * M[i] + (B * B * B - B) * M[i + 1]) * hi * hi / 6;
    };
  }

  function makeInterp(x, y, method) {
    if (method === 'cubic') { try { return makeCubic(x, y); } catch (e) { /* scipy raised: fall back */ } }
    return makeLinear(x, y);
  }

  // numpy.interp (xp increasing), including its handling of repeated xp values
  function npInterp(xv, xp, fp) {
    const n = xp.length;
    if (Number.isNaN(xv)) return NaN;
    if (n === 1) return fp[0];
    if (xv < xp[0]) return fp[0];
    if (xv > xp[n - 1]) return fp[n - 1];
    if (xv === xp[n - 1]) return fp[n - 1];
    const j = searchsortedRight(xp, xv) - 1;
    if (xp[j] === xv) return fp[j];
    const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
    let r = slope * (xv - xp[j]) + fp[j];
    if (Number.isNaN(r)) {
      r = slope * (xv - xp[j + 1]) + fp[j + 1];
      if (Number.isNaN(r) && fp[j] === fp[j + 1]) r = fp[j];
    }
    return r;
  }

  function validXY(t, xCol, yCol) {
    const xs = t.data[xCol].map(toNum), ys = t.data[yCol].map(toNum);
    const x = [], y = [];
    for (let i = 0; i < xs.length; i++) if (!Number.isNaN(xs[i]) && !Number.isNaN(ys[i])) { x.push(xs[i]); y.push(ys[i]); }
    return { x, y, xAll: xs };
  }

  function minMax(a) {
    let lo = Infinity, hi = -Infinity;
    for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return [lo, hi];
  }

  // _sweep_directions: +1/-1 per point in measurement order, from the 5-point smoothed np.gradient
  function sweepDirections(x) {
    const n = x.length;
    if (n < 2) return new Array(n).fill(1);
    const g = x.map((v, i) => (i === 0 ? x[1] - x[0] : i === n - 1 ? x[n - 1] - x[n - 2] : (x[i + 1] - x[i - 1]) / 2));
    const w = Math.min(5, n);
    // rounding residue of a jitter that cancels out counts as "not moving"
    let gmax = 0;
    for (const v of g) if (Math.abs(v) > gmax) gmax = Math.abs(v);
    const tol = 1e-9 * gmax;
    const dir = new Array(n);
    for (let i = 0; i < n; i++) {
      // pandas rolling(w, center=True, min_periods=1).mean()
      const s = Math.max(0, i - Math.floor(w / 2)), e = Math.min(n, i - Math.floor(w / 2) + w);
      let sum = 0;
      for (let k = s; k < e; k++) sum += g[k];
      const m = sum / (e - s);
      dir[i] = Math.abs(m) <= tol ? 0 : Math.sign(m);
    }
    let last = 0;
    for (let i = 0; i < n; i++) { if (dir[i] === 0) dir[i] = last; else last = dir[i]; }
    const first = dir.find(d => d !== 0) || 1;
    return dir.map(d => (d === 0 ? first : d));
  }

  // _averaged_interp: up and down sweeps averaged on the x range both cover -> {f, lo, hi}
  function averagedInterp(x, y, sweepType, method) {
    if (sweepType === 'hysteretic') {
      const dir = sweepDirections(x);
      const upX = [], upY = [], dnX = [], dnY = [];
      dir.forEach((d, i) => { if (d > 0) { upX.push(x[i]); upY.push(y[i]); } else if (d < 0) { dnX.push(x[i]); dnY.push(y[i]); } });
      if (upX.length >= 2 && dnX.length >= 2) {
        const [ul, uh] = minMax(upX), [dl, dh] = minMax(dnX);
        const lo = Math.max(ul, dl), hi = Math.min(uh, dh);
        if (hi > lo) {
          const fUp = makeInterp(upX, upY, method), fDn = makeInterp(dnX, dnY, method);
          const xc = linspace(lo, hi, Math.min(upX.length, dnX.length));
          const yAvg = xc.map(v => (fUp(v) + fDn(v)) / 2);
          return { f: makeInterp(xc, yAvg, method), lo, hi, single: false };
        }
      }
      const [lo, hi] = minMax(x);
      return { f: makeInterp(x, y, method), lo, hi, single: true };
    }
    const [lo, hi] = minMax(x);
    return { f: makeInterp(x, y, method), lo, hi, single: false };
  }

  function withColumn(t, name, values) {
    const out = cloneTable(t);
    if (!out.columns.includes(name)) out.columns.push(name);
    out.data[name] = values;
    return out;
  }

  const isAuto = v => v === 'auto' || v === '' || v === undefined || v === null;

  // _symmetric_parts: f(g), f(-g) on g in [-R, R], R limited so both +x and -x are measured
  function symmetricParts(t, xCol, yCol, sweepType, method, xMin, xMax) {
    const { x, y, xAll } = validXY(t, xCol, yCol);
    if (x.length < 3) throw new Error('数据点不足，至少需要 3 个点');
    const { f, lo, hi, single } = averagedInterp(x, y, sweepType, method);
    if (!(lo < 0 && 0 < hi)) throw new Error(`${xCol} 的范围 [${lo}, ${hi}] 没有跨过 0，无法对称化`);
    let r = Math.min(-lo, hi);
    for (const lim of [xMin, xMax]) if (!isAuto(lim)) r = Math.min(r, Math.abs(Number(lim)));
    if (!(r > 0)) throw new Error('对称化范围为空');
    const grid = linspace(-r, r, x.length);
    return { grid, yPlus: grid.map(f), yMinus: grid.map(v => f(-v)), r, xAll, single };
  }

  // _on_original_x: back onto the file's own x, NaN outside [-r, r]
  function onOriginalX(xAll, grid, values, r) {
    return xAll.map(v => (Math.abs(v) <= r ? npInterp(v, grid, values) : NaN));
  }

  // symmetrize_data: (f(x) + f(-x))/2
  function symmetrize(t, xCol, yCol, sweepType, method, xMin, xMax) {
    const p = symmetricParts(t, xCol, yCol, sweepType, method, xMin, xMax);
    const name = 'symmetrized_' + yCol;
    const vals = p.yPlus.map((v, i) => (v + p.yMinus[i]) / 2);
    return { table: withColumn(t, name, onOriginalX(p.xAll, p.grid, vals, p.r)), column: name, range: p.r, single: p.single };
  }

  // antisymmetrize_data: (f(x) - f(-x))/2
  function antisymmetrize(t, xCol, yCol, sweepType, method, xMin, xMax) {
    const p = symmetricParts(t, xCol, yCol, sweepType, method, xMin, xMax);
    const name = 'antisymmetrized_' + yCol;
    const vals = p.yPlus.map((v, i) => (v - p.yMinus[i]) / 2);
    return { table: withColumn(t, name, onOriginalX(p.xAll, p.grid, vals, p.r)), column: name, range: p.r, single: p.single };
  }

  // --------------------------------------------------------------- split
  function fmtE2(v) {
    const [m, e] = v.toExponential(2).split('e');
    const sign = e[0] === '-' ? '-' : '+';
    const digits = e.replace(/^[+-]/, '');
    return m + 'e' + sign + (digits.length < 2 ? '0' + digits : digits);
  }

  function nanMean(a) {
    let s = 0, k = 0;
    for (const v of a) { const n = toNum(v); if (!Number.isNaN(n)) { s += n; k++; } }
    return k ? s / k : NaN;
  }

  // perform_split for one file -> {segments: [{name, table, start, end, direction}], log}
  function splitSweeps(t, name, fieldCol, opts) {
    const minPoints = opts.minPoints;
    const fieldAll = t.data[fieldCol].map(toNum);
    const keep = [];
    fieldAll.forEach((v, i) => { if (!Number.isNaN(v)) keep.push(i); });
    const df = takeRows(t, keep);
    const field = keep.map(i => fieldAll[i]);
    const n = field.length;
    if (n < minPoints * 2) return { segments: [], reason: `数据太短，至少需要 ${minPoints * 2} 个点` };

    const diff = field.map((v, i) => (i === 0 ? NaN : v - field[i - 1]));
    const w = Math.min(5, Math.floor(n / 10));
    // pandas rolling(window=w, center=True).mean(): window [i - floor(w/2), i - floor(w/2) + w)
    const smooth = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const s = i - Math.floor(w / 2), e = s + w;
      if (s < 0 || e > n) continue;
      let sum = 0, ok = true;
      for (let k = s; k < e; k++) { if (Number.isNaN(diff[k])) { ok = false; break; } sum += diff[k]; }
      if (ok) smooth[i] = sum / w;
    }
    const changes = [];
    let dir = null;
    for (let i = 1; i < n; i++) {
      const v = smooth[i];
      if (Number.isNaN(v)) continue;
      let nd;
      if (v > 0) nd = 'up'; else if (v < 0) nd = 'down'; else continue;
      if (dir !== null && nd !== dir) changes.push(i);
      dir = nd;
    }
    const bounds = [0, ...changes, n];
    const filtered = [bounds[0]];
    for (let i = 1; i < bounds.length; i++) if (bounds[i] - filtered[filtered.length - 1] >= minPoints) filtered.push(bounds[i]);
    const last = filtered[filtered.length - 1];
    if (n - last >= minPoints && last !== n) filtered.push(n);
    else if (n - last < minPoints && filtered.length > 1) filtered[filtered.length - 1] = n;
    if (filtered.length <= 2) return { segments: [], reason: '没有检测到多段 sweep' };

    const dot = name.lastIndexOf('.');
    const base = dot >= 0 ? name.slice(0, dot) : name;
    const ext = dot >= 0 ? name.slice(dot) : '';
    const segments = [];
    for (let i = 0; i < filtered.length - 1; i++) {
      const seg = sliceRows(df, filtered[i], filtered[i + 1]);
      const fs = seg.data[fieldCol].map(toNum);
      const direction = fs[fs.length - 1] > fs[0] ? 'up' : 'down';
      let paramStr = '';
      if (opts.paramCol && seg.columns.includes(opts.paramCol)) {
        const m = nanMean(seg.data[opts.paramCol]);
        if (!Number.isNaN(m)) {
          const label = opts.paramAbbrev || opts.paramCol;
          paramStr = (Math.abs(m) >= 1000 || (Math.abs(m) < 0.01 && m !== 0)) ? `${label}=${fmtE2(m)}_` : `${label}=${m.toFixed(3)}_`;
        }
      }
      segments.push({ name: `${paramStr}${base}_sweep${i + 1}_${direction}${ext}`, table: seg, direction,
        fieldStart: fs[0], fieldEnd: fs[fs.length - 1] });
    }
    return { segments };
  }

  // --------------------------------------------------------------- merge
  function unionColumns(tables) {
    const cols = [];
    for (const t of tables) for (const c of t.columns) if (!cols.includes(c)) cols.push(c);
    return cols;
  }

  function concatTables(a, b) {
    const cols = unionColumns([a, b]);
    const na = nrows(a), nb = nrows(b);
    const data = {};
    for (const c of cols) {
      const x = a.data[c] || new Array(na).fill(NaN), y = b.data[c] || new Array(nb).fill(NaN);
      data[c] = x.concat(y);
    }
    return { columns: cols, data };
  }

  function interleaveTables(a, b) {
    const cols = unionColumns([a, b]);
    const na = nrows(a), nb = nrows(b), m = Math.max(na, nb);
    const data = {};
    cols.forEach(c => { data[c] = []; });
    const push = (t, i) => cols.forEach(c => data[c].push(t.data[c] ? t.data[c][i] : NaN));
    for (let j = 0; j < m; j++) { if (j < na) push(a, j); if (j < nb) push(b, j); }
    return { columns: cols, data };
  }

  function combine(a, b, strategy) {
    return strategy === 'interleave' ? interleaveTables(a, b) : concatTables(a, b);
  }

  // filename stem used by merge_all_files / merge_sequential_pairs
  function mergeBase(filename) {
    let base = filename.includes('_sweep') ? filename.split('_sweep')[0] : filename;
    const parts = base.split('_');
    if (parts.length > 1 && parts[0].includes('=')) {
      const joined = parts.slice(1).join('_');
      base = joined || base;
    }
    if (!base || base === 'None') base = 'merged_file';
    return base;
  }

  // -> [{name, table, sources, parentOf}] ; getTable(name) returns current table
  function mergeAll(names, strategy, getTable) {
    let combined = null, base = 'merged_hysteresis';
    names.forEach((fn, i) => {
      const t = getTable(fn);
      if (!t) return;
      if (combined === null) {
        combined = cloneTable(t);
        if (fn.includes('_sweep')) base = mergeBase(fn);
      } else combined = combine(combined, t, strategy);
    });
    if (!combined) return [];
    if (!base || base === 'None') base = 'merged_file';
    return [{ name: `${base}_hysteresis_merged`, table: combined, sources: names, anchor: names[0] }];
  }

  function mergeSequential(names, strategy, getTable) {
    const out = [];
    for (let i = 0; i + 1 < names.length; i += 2) {
      const a = getTable(names[i]), b = getTable(names[i + 1]);
      if (!a || !b) continue;
      out.push({ name: `${mergeBase(names[i])}_hysteresis_pair${out.length + 1}`, table: combine(a, b, strategy),
        sources: [names[i], names[i + 1]], anchor: names[i] });
    }
    return out;
  }

  function mergeSmart(names, strategy, getTable) {
    const groups = new Map();
    for (const fn of names) {
      let key = 'no_param';
      if (fn.includes('=')) { const p = fn.split('_')[0]; if (p.includes('=')) key = p; }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(fn);
    }
    const out = [];
    for (const files of groups.values()) {
      if (files.length < 2) continue;
      const ups = files.filter(f => f.includes('_up')), downs = files.filter(f => f.includes('_down'));
      for (let i = 0; i < Math.min(ups.length, downs.length); i++)
        out.push(...mergeSequential([ups[i], downs[i]], strategy, getTable));
    }
    return out.length ? out : mergeSequential(names, strategy, getTable);
  }

  // ---------------------------------------------------------------- export
  function csvCell(v) {
    if (isMissing(v)) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // DataFrame.to_csv(index=False)
  function toCsv(t) {
    const lines = [t.columns.map(csvCell).join(',')];
    const n = nrows(t);
    for (let i = 0; i < n; i++) lines.push(t.columns.map(c => csvCell(t.data[c][i])).join(','));
    return lines.join('\n') + '\n';
  }

  // copy_to_clipboard: X/Y pairs side by side, tab separated
  function xyColumns(files, xCol, yCol, getTable) {
    const cols = [], headers = [];
    for (const fn of files) {
      const t = getTable(fn);
      if (!t || !t.columns.includes(xCol) || !t.columns.includes(yCol)) continue;
      cols.push(t.data[xCol], t.data[yCol]);
      headers.push(`${fn}_${xCol}`, `${fn}_${yCol}`);
    }
    return { cols, headers };
  }

  function xyTsv(files, xCol, yCol, getTable) {
    const { cols, headers } = xyColumns(files, xCol, yCol, getTable);
    if (!cols.length) return null;
    const m = Math.max(...cols.map(c => c.length));
    const lines = [headers.join('\t')];
    for (let i = 0; i < m; i++) lines.push(cols.map(c => (i < c.length && !isMissing(c[i]) ? String(c[i]) : '')).join('\t'));
    return { text: lines.join('\n'), pairs: cols.length / 2 };
  }

  // ---------------------------------------------------------- file manager
  // EnhancedFileManager: names are unique keys; folders hold ordered child names.
  class FileManager {
    constructor() { this.nodes = new Map(); this.rootItems = []; }

    _attach(name, parent) {
      if (parent && this.nodes.has(parent)) this.nodes.get(parent).children.push(name);
      else this.rootItems.push(name);
    }

    addFile(filename, table, parent = null) {
      const original = filename;
      let counter = 1;
      while (this.nodes.has(filename)) {
        const dot = original.lastIndexOf('.');
        filename = dot >= 0 ? `${original.slice(0, dot)}_${counter}${original.slice(dot)}` : `${original}_${counter}`;
        counter++;
      }
      const p = parent && this.nodes.has(parent) ? parent : null;
      const node = { name: filename, isFolder: false, parent: p, children: [], data: table, modified: null };
      this.nodes.set(filename, node);
      this._attach(filename, p);
      return node;
    }

    addFolder(folderName, parent = null) {
      const original = folderName;
      let counter = 1;
      const p = parent && this.nodes.has(parent) ? parent : null;
      while (this.nodes.has(folderName)) {
        const ex = this.nodes.get(folderName);
        if (ex.isFolder && ex.parent === p) return ex;
        folderName = `${original}_${counter}`;
        counter++;
      }
      const node = { name: folderName, isFolder: true, parent: p, children: [] };
      this.nodes.set(folderName, node);
      this._attach(folderName, p);
      return node;
    }

    siblings(name) {
      const n = this.nodes.get(name);
      return n && n.parent ? this.nodes.get(n.parent).children : this.rootItems;
    }

    filesRecursive(name) {
      const n = this.nodes.get(name);
      if (!n) return [];
      if (!n.isFolder) return [name];
      return n.children.flatMap(c => this.filesRecursive(c));
    }

    isInside(name, folder) {
      for (let n = this.nodes.get(name); n && n.parent; n = this.nodes.get(n.parent)) if (n.parent === folder) return true;
      return false;
    }

    moveItem(name, target, position = -1) {
      const n = this.nodes.get(name);
      if (!n || name === target || (target && this.isInside(target, name))) return false;
      const sib = this.siblings(name);
      sib.splice(sib.indexOf(name), 1);
      n.parent = target && this.nodes.has(target) ? target : null;
      const dest = n.parent ? this.nodes.get(n.parent).children : this.rootItems;
      if (position >= 0) dest.splice(position, 0, name); else dest.push(name);
      return true;
    }

    deleteItem(name) {
      const n = this.nodes.get(name);
      if (!n) return;
      if (n.isFolder) for (const c of n.children.slice()) this.deleteItem(c);
      const sib = this.siblings(name);
      const i = sib.indexOf(name);
      if (i >= 0) sib.splice(i, 1);
      this.nodes.delete(name);
    }

    rename(oldName, newName) {
      if (!newName || oldName === newName || this.nodes.has(newName)) return false;
      const n = this.nodes.get(oldName);
      if (!n) return false;
      const sib = this.siblings(oldName);
      sib[sib.indexOf(oldName)] = newName;
      if (n.isFolder) n.children.forEach(c => { this.nodes.get(c).parent = newName; });
      this.nodes.delete(oldName);
      n.name = newName;
      this.nodes.set(newName, n);
      return true;
    }

    current(name) {
      const n = this.nodes.get(name);
      return n && !n.isFolder ? (n.modified || n.data) : null;
    }

    update(name, table) {
      const n = this.nodes.get(name);
      if (n && !n.isFolder) n.modified = table;
    }

    reset(name) {
      const n = this.nodes.get(name);
      if (n && !n.isFolder && n.modified) { n.modified = null; return true; }
      return false;
    }

    // tree order walk: [{name, depth}]
    walk() {
      const out = [];
      const rec = (names, depth) => names.forEach(nm => { out.push({ name: nm, depth }); const n = this.nodes.get(nm); if (n.isFolder) rec(n.children, depth + 1); });
      rec(this.rootItems, 0);
      return out;
    }

    path(name) {
      const parts = [];
      for (let n = this.nodes.get(name); n; n = n.parent ? this.nodes.get(n.parent) : null) parts.unshift(n.name);
      return parts.join('/');
    }
  }

  // ------------------------------------------------------- project (JSON)
  const PROJECT_FORMAT = 'datapro-web-project';

  function encodeCol(a) { return a.map(v => (typeof v === 'number' && !Number.isFinite(v) ? (Number.isNaN(v) ? null : (v > 0 ? 'inf' : '-inf')) : v)); }
  function decodeCol(a) { return a.map(v => (v === null ? NaN : v === 'inf' ? Infinity : v === '-inf' ? -Infinity : v)); }
  function encodeTable(t) { return { columns: t.columns, data: t.columns.map(c => encodeCol(t.data[c])) }; }
  function decodeTable(o) { return makeTable(o.columns, o.data.map(decodeCol)); }

  // export_project equivalent: current data of every file, tree order preserved
  function projectToJson(fm) {
    const items = fm.walk().map(({ name }) => {
      const n = fm.nodes.get(name);
      const it = { name, is_folder: n.isFolder, parent_folder: n.parent || '' };
      if (!n.isFolder) it.table = encodeTable(fm.current(name));
      return it;
    });
    return JSON.stringify({ format: PROJECT_FORMAT, version: 1, items });
  }

  function projectFromJson(text) {
    const o = JSON.parse(text);
    if (!o || o.format !== PROJECT_FORMAT) throw new Error('不是 DataPro 网页版的工程文件');
    return o.items.map(it => ({ name: it.name, isFolder: !!it.is_folder, parent: it.parent_folder || null,
      table: it.is_folder ? undefined : decodeTable(it.table) }));
  }

  root.DP = {
    FileManager, projectToJson, projectFromJson,
    nrows, makeTable, cloneTable, takeRows, toNum, isMissing,
    parseTextFile, parseHkFile, detectDataStructure,
    parsePickledStrList, readHdfProject, hdfStoreKeys, readPandasGroup,
    makeLinear, makeCubic, npInterp, linspace,
    symmetrize, antisymmetrize, splitSweeps,
    mergeAll, mergeSequential, mergeSmart, mergeBase,
    toCsv, xyColumns, xyTsv,
  };
})(typeof window !== 'undefined' ? window : globalThis);
