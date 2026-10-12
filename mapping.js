// DataPro web: 2D transport mapping.
// Ported from the "2D Transport Mapping" section of "datapro 20261012.py". scipy's griddata
// (Delaunay + LinearND / Clough-Tocher) is reimplemented here on top of Delaunator.
(function (root) {
  'use strict';
  const DP = root.DP;
  const finite = Number.isFinite;

  // ---------------------------------------------------------------- small numerics
  function linspace(a, b, n) {
    const out = new Float64Array(n);
    if (n === 1) { out[0] = a; return out; }
    const step = (b - a) / (n - 1);
    for (let i = 0; i < n; i++) out[i] = a + i * step;
    out[n - 1] = b;
    return out;
  }

  function nanMinMax(a) {
    let lo = Infinity, hi = -Infinity;
    for (const v of a) if (!Number.isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return [lo, hi];
  }

  function median(values) {
    const a = Float64Array.from(values).sort();
    const n = a.length;
    if (!n) return NaN;
    return n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  // numpy.nanpercentile with linear interpolation
  function nanPercentile(a, q) {
    const v = Float64Array.from(Array.prototype.filter.call(a, finite)).sort();
    if (!v.length) return NaN;
    const pos = (v.length - 1) * q / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  }

  function argsortStable(x, idx) {
    return idx.slice().sort((a, b) => (x[a] - x[b]) || (a - b));
  }

  // interp1d(kind='linear', bounds_error=False, fill_value=fill) on unsorted input
  function interpLinear(xIn, yIn, fillLo, fillHi) {
    const idx = argsortStable(xIn, Array.from(xIn, (_, i) => i));
    const x = idx.map(i => xIn[i]), y = idx.map(i => yIn[i]);
    const n = x.length;
    return v => {
      if (Number.isNaN(v)) return NaN;
      if (v < x[0]) return fillLo;
      if (v > x[n - 1]) return fillHi;
      return DP.npInterp(v, x, y);
    };
  }

  // ---------------------------------------------------------------- per-trace processing
  // mapping_symmetrize / mapping_anti_symmetrize
  function mirror(sweep, signal, sign) {
    const vx = [], vy = [];
    for (let i = 0; i < sweep.length; i++) if (!Number.isNaN(sweep[i]) && !Number.isNaN(signal[i])) { vx.push(sweep[i]); vy.push(signal[i]); }
    if (vx.length < 4) return Float64Array.from(signal);
    const f = interpLinear(vx, vy, NaN, NaN);
    return Float64Array.from(signal, (s, i) => (s + sign * f(-sweep[i])) / 2);
  }
  const mappingSymmetrize = (sweep, signal) => mirror(sweep, signal, 1);
  const mappingAntiSymmetrize = (sweep, signal) => mirror(sweep, signal, -1);

  // mapping_subtract_background: straight-line fit over the outer 20 % of the sweep range
  function mappingSubtractBackground(sweep, signal, log) {
    const valid = i => !Number.isNaN(sweep[i]) && !Number.isNaN(signal[i]);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < sweep.length; i++) if (valid(i)) { lo = Math.min(lo, sweep[i]); hi = Math.max(hi, sweep[i]); }
    const threshold = 0.8 * (hi - lo) + lo;
    let n = 0, sx = 0, sy = 0;
    const fx = [], fy = [];
    for (let i = 0; i < sweep.length; i++) if (valid(i) && Math.abs(sweep[i]) >= threshold) { fx.push(sweep[i]); fy.push(signal[i]); }
    n = fx.length;
    if (n < 2) { log && log('背景拟合的点不足，已跳过扣背景'); return Float64Array.from(signal); }
    for (let i = 0; i < n; i++) { sx += fx[i]; sy += fy[i]; }
    const mx = sx / n, my = sy / n;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (fx[i] - mx) ** 2; sxy += (fx[i] - mx) * (fy[i] - my); }
    const k = sxy / sxx, b = my - k * mx;
    return Float64Array.from(signal, (s, i) => s - (k * sweep[i] + b));
  }

  // mapping_align_traces -> {sweep: Float64Array(n), aligned: [Float64Array(n) per trace]}
  function mappingAlignTraces(sweeps, signals, rangeMode, fillMode, log) {
    const mins = [], maxs = [], lens = [];
    for (const sw of sweeps) {
      const [lo, hi] = nanMinMax(sw);
      let k = 0;
      for (const v of sw) if (!Number.isNaN(v)) k++;
      if (!k) continue;
      mins.push(lo); maxs.push(hi); lens.push(k);
    }
    if (!mins.length) throw new Error('没有有效的扫描数据');
    let cmin, cmax, n;
    if (rangeMode === 'union') { cmin = Math.min(...mins); cmax = Math.max(...maxs); n = Math.max(...lens); }
    else { cmin = Math.max(...mins); cmax = Math.min(...maxs); n = Math.min(...lens); }
    if (cmin >= cmax) {
      log && log('各文件的扫描范围没有重叠，改用并集');
      cmin = Math.min(...mins); cmax = Math.max(...maxs); n = Math.max(...lens);
    }
    const sweep = linspace(cmin, cmax, n);
    const aligned = sweeps.map((sw, j) => {
      const sg = signals[j], vx = [], vy = [];
      for (let i = 0; i < sw.length; i++) if (!Number.isNaN(sw[i]) && !Number.isNaN(sg[i])) { vx.push(sw[i]); vy.push(sg[i]); }
      const out = new Float64Array(n).fill(NaN);
      if (vx.length < 4) return out;
      let f;
      if (rangeMode === 'union' && fillMode === 'boundary') {
        const ord = argsortStable(vx, vx.map((_, i) => i));
        f = interpLinear(vx, vy, vy[ord[0]], vy[ord[ord.length - 1]]);
      } else f = interpLinear(vx, vy, NaN, NaN);
      for (let i = 0; i < n; i++) out[i] = f(sweep[i]);
      return out;
    });
    return { sweep, aligned };
  }

  // ---------------------------------------------------------------- griddata
  // Triangulation plus the per-simplex neighbour table scipy's Delaunay exposes
  // (neighbour k is the triangle opposite vertex k).
  function triangulate(px, py) {
    const n = px.length;
    const coords = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) { coords[2 * i] = px[i]; coords[2 * i + 1] = py[i]; }
    const d = new root.Delaunator(coords);
    const tri = d.triangles, he = d.halfedges, nt = tri.length / 3;
    // Points that only differ from a line by rounding still triangulate here, into slivers;
    // Qhull refuses them ("initial simplex is flat"), and so do we.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, area = 0;
    for (let i = 0; i < n; i++) { x0 = Math.min(x0, px[i]); x1 = Math.max(x1, px[i]); y0 = Math.min(y0, py[i]); y1 = Math.max(y1, py[i]); }
    for (let t = 0; t < nt; t++) {
      const a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
      area += Math.abs((px[b] - px[a]) * (py[c] - py[a]) - (px[c] - px[a]) * (py[b] - py[a])) / 2;
    }
    if (!nt || !(area > 1e-9 * (x1 - x0) * (y1 - y0))) throw new Error('数据点几乎在一条直线上（或太少），无法做二维插值');
    const nb = new Int32Array(3 * nt);
    for (let t = 0; t < nt; t++) {
      // edge 3t+1 (v1->v2) is opposite v0, 3t+2 opposite v1, 3t opposite v2
      const opp = [3 * t + 1, 3 * t + 2, 3 * t];
      for (let k = 0; k < 3; k++) { const h = he[opp[k]]; nb[3 * t + k] = h < 0 ? -1 : Math.floor(h / 3); }
    }
    return { px, py, tri, nb, nt };
  }

  function barycentric(T, t, x, y, out) {
    const a = T.tri[3 * t], b = T.tri[3 * t + 1], c = T.tri[3 * t + 2];
    const xa = T.px[a], ya = T.py[a], xb = T.px[b], yb = T.py[b], xc = T.px[c], yc = T.py[c];
    const det = (yb - yc) * (xa - xc) + (xc - xb) * (ya - yc);
    out[0] = ((yb - yc) * (x - xc) + (xc - xb) * (y - yc)) / det;
    out[1] = ((yc - ya) * (x - xc) + (xa - xc) * (y - yc)) / det;
    out[2] = 1 - out[0] - out[1];
    return out;
  }

  // scipy.interpolate.interpnd.estimate_gradients_2d_global
  function estimateGradients(T, z, maxiter = 400, tol = 1e-6) {
    const n = T.px.length;
    const nbrs = Array.from({ length: n }, () => new Set());
    for (let t = 0; t < T.nt; t++) {
      const a = T.tri[3 * t], b = T.tri[3 * t + 1], c = T.tri[3 * t + 2];
      nbrs[a].add(b); nbrs[a].add(c); nbrs[b].add(a); nbrs[b].add(c); nbrs[c].add(a); nbrs[c].add(b);
    }
    const adj = nbrs.map(s => Int32Array.from([...s].sort((p, q) => p - q)));
    const gx = new Float64Array(n), gy = new Float64Array(n);
    for (let it = 0; it < maxiter; it++) {
      let err = 0;
      for (let i = 0; i < n; i++) {
        const nb = adj[i];
        if (!nb.length) continue;
        let q0 = 0, q1 = 0, q3 = 0, s0 = 0, s1 = 0;
        for (const j of nb) {
          const ex = T.px[j] - T.px[i], ey = T.py[j] - T.py[i];
          const L = Math.sqrt(ex * ex + ey * ey), L3 = L * L * L;
          const f1 = z[i], f2 = z[j];
          const df2 = -ex * gx[j] - ey * gy[j];
          q0 += 4 * ex * ex / L3; q1 += 4 * ex * ey / L3; q3 += 4 * ey * ey / L3;
          s0 += (6 * (f1 - f2) - 2 * df2) * ex / L3;
          s1 += (6 * (f1 - f2) - 2 * df2) * ey / L3;
        }
        const det = q0 * q3 - q1 * q1;
        const r0 = (q3 * s0 - q1 * s1) / det, r1 = (-q1 * s0 + q0 * s1) / det;
        let change = Math.max(Math.abs(gx[i] + r0), Math.abs(gy[i] + r1));
        gx[i] = -r0; gy[i] = -r1;
        change /= Math.max(1, Math.max(Math.abs(r0), Math.abs(r1)));
        if (change > err) err = change;
      }
      if (err < tol) break;
    }
    return { gx, gy };
  }

  // scipy's _clough_tocher_2d_single
  function cloughTocher(T, G, z, t, b) {
    const v0 = T.tri[3 * t], v1 = T.tri[3 * t + 1], v2 = T.tri[3 * t + 2];
    const e12x = T.px[v1] - T.px[v0], e12y = T.py[v1] - T.py[v0];
    const e23x = T.px[v2] - T.px[v1], e23y = T.py[v2] - T.py[v1];
    const e31x = T.px[v0] - T.px[v2], e31y = T.py[v0] - T.py[v2];
    const f1 = z[v0], f2 = z[v1], f3 = z[v2];
    const df12 = +(G.gx[v0] * e12x + G.gy[v0] * e12y);
    const df21 = -(G.gx[v1] * e12x + G.gy[v1] * e12y);
    const df23 = +(G.gx[v1] * e23x + G.gy[v1] * e23y);
    const df32 = -(G.gx[v2] * e23x + G.gy[v2] * e23y);
    const df31 = +(G.gx[v2] * e31x + G.gy[v2] * e31y);
    const df13 = -(G.gx[v0] * e31x + G.gy[v0] * e31y);
    const c3000 = f1, c2100 = (df12 + 3 * c3000) / 3, c2010 = (df13 + 3 * c3000) / 3;
    const c0300 = f2, c1200 = (df21 + 3 * c0300) / 3, c0210 = (df23 + 3 * c0300) / 3;
    const c0030 = f3, c1020 = (df31 + 3 * c0030) / 3, c0120 = (df32 + 3 * c0030) / 3;
    const c2001 = (c2100 + c2010 + c3000) / 3, c0201 = (c1200 + c0300 + c0210) / 3, c0021 = (c1020 + c0120 + c0030) / 3;
    // affine-invariant edge-normal directions from the neighbours' centroids
    const g = [0, 0, 0], c = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const it = T.nb[3 * t + k];
      if (it === -1) { g[k] = -0.5; continue; }
      const a = T.tri[3 * it], bb = T.tri[3 * it + 1], cc = T.tri[3 * it + 2];
      barycentric(T, t, (T.px[a] + T.px[bb] + T.px[cc]) / 3, (T.py[a] + T.py[bb] + T.py[cc]) / 3, c);
      if (k === 0) g[k] = (2 * c[2] + c[1] - 1) / (2 - 3 * c[2] - 3 * c[1]);
      else if (k === 1) g[k] = (2 * c[0] + c[2] - 1) / (2 - 3 * c[0] - 3 * c[2]);
      else g[k] = (2 * c[1] + c[0] - 1) / (2 - 3 * c[1] - 3 * c[0]);
    }
    const c0111 = (g[0] * (-c0300 + 3 * c0210 - 3 * c0120 + c0030) + (-c0300 + 2 * c0210 - c0120 + c0021 + c0201)) / 2;
    const c1011 = (g[1] * (-c0030 + 3 * c1020 - 3 * c2010 + c3000) + (-c0030 + 2 * c1020 - c2010 + c2001 + c0021)) / 2;
    const c1101 = (g[2] * (-c3000 + 3 * c2100 - 3 * c1200 + c0300) + (-c3000 + 2 * c2100 - c1200 + c2001 + c0201)) / 2;
    const c1002 = (c1101 + c1011 + c2001) / 3, c0102 = (c1101 + c0111 + c0201) / 3, c0012 = (c1011 + c0111 + c0021) / 3;
    const c0003 = (c1002 + c0102 + c0012) / 3;
    const minval = Math.min(b[0], b[1], b[2]);
    const b1 = b[0] - minval, b2 = b[1] - minval, b3 = b[2] - minval, b4 = 3 * minval;
    return (b1 ** 3 * c3000 + 3 * b1 ** 2 * b2 * c2100 + 3 * b1 ** 2 * b3 * c2010 +
      3 * b1 ** 2 * b4 * c2001 + 3 * b1 * b2 ** 2 * c1200 +
      6 * b1 * b2 * b4 * c1101 + 3 * b1 * b3 ** 2 * c1020 + 6 * b1 * b3 * b4 * c1011 +
      3 * b1 * b4 ** 2 * c1002 + b2 ** 3 * c0300 + 3 * b2 ** 2 * b3 * c0210 +
      3 * b2 ** 2 * b4 * c0201 + 3 * b2 * b3 ** 2 * c0120 + 6 * b2 * b3 * b4 * c0111 +
      3 * b2 * b4 ** 2 * c0102 + b3 ** 3 * c0030 + 3 * b3 ** 2 * b4 * c0021 +
      3 * b3 * b4 ** 2 * c0012 + b4 ** 3 * c0003);
  }

  // scipy.interpolate.griddata((px, py), z, meshgrid(xi, yi), method) -> Float64Array(ny*nx), row = y.
  // Grid points outside the convex hull stay NaN. method 'cubic' falls back to 'linear' like the desktop code.
  function griddata(px, py, z, xi, yi, method, log) {
    const T = triangulate(px, py);
    let G = null;
    if (method === 'cubic') {
      try { G = estimateGradients(T, z); } catch (e) { log && log('三次插值失败，改用线性'); }
    }
    const nx = xi.length, ny = yi.length;
    const out = new Float64Array(nx * ny).fill(NaN);
    const x0 = xi[0], dx = nx > 1 ? (xi[nx - 1] - xi[0]) / (nx - 1) : 1;
    const y0 = yi[0], dy = ny > 1 ? (yi[ny - 1] - yi[0]) / (ny - 1) : 1;
    const eps = 100 * 2.220446049250313e-16, b = [0, 0, 0];
    for (let t = 0; t < T.nt; t++) {
      const a = T.tri[3 * t], bb = T.tri[3 * t + 1], c = T.tri[3 * t + 2];
      const tx0 = Math.min(T.px[a], T.px[bb], T.px[c]), tx1 = Math.max(T.px[a], T.px[bb], T.px[c]);
      const ty0 = Math.min(T.py[a], T.py[bb], T.py[c]), ty1 = Math.max(T.py[a], T.py[bb], T.py[c]);
      const i0 = Math.max(0, Math.ceil((tx0 - x0) / dx - 1e-9)), i1 = Math.min(nx - 1, Math.floor((tx1 - x0) / dx + 1e-9));
      const j0 = Math.max(0, Math.ceil((ty0 - y0) / dy - 1e-9)), j1 = Math.min(ny - 1, Math.floor((ty1 - y0) / dy + 1e-9));
      for (let j = j0; j <= j1; j++) {
        const y = yi[j];
        for (let i = i0; i <= i1; i++) {
          const k = j * nx + i;
          if (!Number.isNaN(out[k])) continue;
          barycentric(T, t, xi[i], y, b);
          if (b[0] < -eps || b[1] < -eps || b[2] < -eps || b[0] > 1 + eps || b[1] > 1 + eps || b[2] > 1 + eps) continue;
          out[k] = G ? cloughTocher(T, G, z, t, b) : b[0] * z[a] + b[1] * z[bb] + b[2] * z[c];
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- nearest-neighbour mask
  // Bucketed nearest-neighbour search standing in for scipy's cKDTree.
  function nnIndex(px, py) {
    const n = px.length;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) { x0 = Math.min(x0, px[i]); x1 = Math.max(x1, px[i]); y0 = Math.min(y0, py[i]); y1 = Math.max(y1, py[i]); }
    const side = Math.max(1, Math.round(Math.sqrt(n / 2)));
    const cw = (x1 - x0) / side || 1, ch = (y1 - y0) / side || 1;
    const cell = (x, y) => [Math.min(side - 1, Math.max(0, Math.floor((x - x0) / cw))), Math.min(side - 1, Math.max(0, Math.floor((y - y0) / ch)))];
    const buckets = Array.from({ length: side * side }, () => []);
    for (let i = 0; i < n; i++) { const [cx, cy] = cell(px[i], py[i]); buckets[cy * side + cx].push(i); }
    // distance from (x, y) to its nearest point, skipping index `skip`
    return (x, y, skip = -1) => {
      const [cx, cy] = cell(x, y);
      let best = Infinity;
      for (let r = 0; r <= side; r++) {
        for (let gy = cy - r; gy <= cy + r; gy++) {
          if (gy < 0 || gy >= side) continue;
          for (let gx = cx - r; gx <= cx + r; gx++) {
            if (gx < 0 || gx >= side || (Math.abs(gx - cx) !== r && Math.abs(gy - cy) !== r)) continue;
            for (const k of buckets[gy * side + gx]) {
              if (k === skip) continue;
              const d = Math.hypot(px[k] - x, py[k] - y);
              if (d < best) best = d;
            }
          }
        }
        // anything not yet searched lies outside the (2r+1)^2 block of cells around the query
        const reach = Math.min(x - (x0 + (cx - r) * cw), x0 + (cx + r + 1) * cw - x,
          y - (y0 + (cy - r) * ch), y0 + (cy + r + 1) * ch - y);
        if (best <= reach) break;
      }
      return best;
    };
  }

  // mapping_grid_scattered
  function mappingGridScattered(xp, yp, zp, nGrid, log) {
    const xv = [], yv = [], zv = [];
    for (let i = 0; i < xp.length; i++) if (finite(xp[i]) && finite(yp[i]) && finite(zp[i])) { xv.push(xp[i]); yv.push(yp[i]); zv.push(zp[i]); }
    if (xv.length < 4) throw new Error('有效数据点不足，无法插值成网格');
    const [xa, xb] = nanMinMax(xv), [ya, yb] = nanMinMax(yv);
    const xi = linspace(xa, xb, nGrid), yi = linspace(ya, yb, nGrid);
    const Z = griddata(xv, yv, zv, xi, yi, 'cubic', log);
    // blank cells far from any measured point
    const sx = (xb - xa) > 0 ? xb - xa : 1, sy = (yb - ya) > 0 ? yb - ya : 1;
    const nxp = xv.map(v => v / sx), nyp = yv.map(v => v / sy);
    const near = nnIndex(nxp, nyp);
    const nn = nxp.map((v, i) => near(v, nyp[i], i));
    const threshold = 2 * median(nn);
    for (let j = 0; j < nGrid; j++) for (let i = 0; i < nGrid; i++) {
      if (near(xi[i] / sx, yi[j] / sy) > threshold) Z[j * nGrid + i] = NaN;
    }
    return { xi, yi, Z };
  }

  // mapping_make_2d_grid: aligned[j][i] is file j at sweep point i
  function mappingMake2dGrid(sweep, params, aligned, nGrid, log) {
    const xp = [], yp = [], zp = [];
    params.forEach((pv, j) => sweep.forEach((sv, i) => { const v = aligned[j][i]; if (!Number.isNaN(v)) { xp.push(sv); yp.push(pv); zp.push(v); } }));
    const [xa, xb] = nanMinMax(sweep), [ya, yb] = nanMinMax(params);
    const xi = linspace(xa, xb, nGrid), yi = linspace(ya, yb, nGrid);
    return { xi, yi, Z: griddata(xp, yp, zp, xi, yi, 'cubic', log) };
  }

  // mapping_calc_sweep_ratio
  function mappingCalcSweepRatio(xs, ys, log) {
    const ratios = [];
    xs.forEach((xa, k) => {
      const ya = ys[k], vx = [], vy = [];
      for (let i = 0; i < xa.length; i++) if (finite(xa[i]) && finite(ya[i])) { vx.push(xa[i]); vy.push(ya[i]); }
      if (vx.length < 2) return;
      const dx = vx[vx.length - 1] - vx[0];
      if (Math.abs(dx) < 1e-15) return;
      ratios.push((vy[vy.length - 1] - vy[0]) / dx);
    });
    if (!ratios.length) { log && log('无法计算扫描比例，按 1.0 处理'); return 1; }
    const r = median(ratios);
    log && log(`扫描比例 dY/dX = ${+r.toPrecision(6)}（来自 ${ratios.length} 条曲线）`);
    return r;
  }

  // mapping_transform_coords: rotate into n (along the sweep) and D (across it), then re-grid
  function mappingTransformCoords(G, ratio, nGrid, log) {
    const norm = Math.sqrt(1 + ratio * ratio), nx = G.xi.length;
    const xv = [], yv = [], zv = [];
    for (let j = 0; j < G.yi.length; j++) for (let i = 0; i < nx; i++) {
      const z = G.Z[j * nx + i];
      if (!finite(z)) continue;
      const X = G.xi[i], Y = G.yi[j];
      xv.push((X + ratio * Y) / norm); yv.push((-ratio * X + Y) / norm); zv.push(z);
    }
    if (xv.length < 4) { log && log('变换后的有效点不足，无法重新插值'); return G; }
    const [xa, xb] = nanMinMax(xv), [ya, yb] = nanMinMax(yv);
    const xi = linspace(xa, xb, nGrid), yi = linspace(ya, yb, nGrid);
    return { xi, yi, Z: griddata(xv, yv, zv, xi, yi, 'cubic', log) };
  }

  function fillNaN(arr, mode) {
    if (mode === 'nan') return;
    let v = 0;
    if (mode === 'max' || mode === 'min') {
      let lo = Infinity, hi = -Infinity;
      for (const a of arr) if (!Number.isNaN(a)) { if (a < lo) lo = a; if (a > hi) hi = a; }
      v = mode === 'max' ? hi : lo;
    }
    for (let i = 0; i < arr.length; i++) if (Number.isNaN(arr[i])) arr[i] = v;
  }

  const logAbs = a => Float64Array.from(a, v => { const r = Math.log10(Math.abs(v)); return finite(r) ? r : NaN; });

  // ---------------------------------------------------------------- the generate_map pipeline
  // files: [{name, cols: {colName: number[]}}]; s: settings as in the desktop dialog.
  // -> {xi, yi, Z (row = y), nx, ny, vmin, vmax, zlabel, discrete}
  function computeMapping(files, s, log = () => {}) {
    const num = c => Float64Array.from(c, DP.toNum);
    const col = (f, name) => { if (!(name in f.cols)) throw new Error(`${f.name} 里没有“${name}”列`); return num(f.cols[name]); };
    if (s.xCol === s.zCol) throw new Error('X 列和 Z 列不能相同');
    const nGrid = Math.max(10, Math.min(2000, Math.round(s.grid) || 600));
    let G, discrete = false;

    const process = (sw, sg) => {
      if (s.sym) sg = mappingSymmetrize(sw, sg);
      else if (s.asym) sg = mappingAntiSymmetrize(sw, sg);
      if (s.bg) sg = mappingSubtractBackground(sw, sg, log);
      return sg;
    };

    if (s.mode === 'dual_gate') {
      if (s.yColDual === s.xCol || s.yColDual === s.zCol) throw new Error('X、Y、Z 三列必须各不相同');
      const xs = [], ys = [], zs = [];
      for (const f of files) {
        const x = col(f, s.xCol), y = col(f, s.yColDual);
        xs.push(x); ys.push(y); zs.push(process(x, col(f, s.zCol)));
      }
      const cat = arrs => { const out = new Float64Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
      const ax = cat(xs), ay = cat(ys);
      let az = cat(zs);
      log(`双栅模式：${files.length} 个文件共 ${ax.length} 个点`);
      if (s.log) az = logAbs(az);
      G = mappingGridScattered(ax, ay, az, nGrid, log);
      if (s.transform) {
        const ratio = s.transformMode === 'auto' ? mappingCalcSweepRatio(xs, ys, log) : Number(s.transformRatio);
        if (!finite(ratio)) throw new Error('变换比例要填数字');
        G = mappingTransformCoords(G, ratio, nGrid, log);
        log(`已做坐标变换，比例 r = ${+ratio.toPrecision(6)}`);
      }
    } else {
      let params;
      if (s.ySource === 'manual') {
        const text = String(s.yManual || '').trim();
        if (!text) throw new Error('请填写每个文件对应的 Y 值，用逗号分隔');
        params = text.split(/[,，]/).map(v => Number(v.trim()));
        if (params.some(v => !finite(v))) throw new Error('Y 值里有不是数字的项');
        if (params.length !== files.length) throw new Error(`填了 ${params.length} 个 Y 值，但选了 ${files.length} 个文件，数量要一致`);
      } else {
        params = files.map(f => {
          const v = Array.from(col(f, s.yCol)).filter(a => !Number.isNaN(a));
          if (!v.length) return NaN;
          switch (s.yAgg) {
            case 'min': return Math.min(...v);
            case 'mean': return v.reduce((a, b) => a + b, 0) / v.length;
            case 'median': return median(v);
            case 'first': return v[0];
            default: return Math.max(...v);
          }
        });
      }
      log(`Y 参数值：${params.map(v => +v.toPrecision(6)).join(', ')}`);
      const sweeps = files.map(f => col(f, s.xCol));
      const signals = files.map((f, i) => process(sweeps[i], col(f, s.zCol)));
      const rm = s.rangeMode;
      const A = rm === 'union_boundary' ? mappingAlignTraces(sweeps, signals, 'union', 'boundary', log)
        : rm === 'union_nan' ? mappingAlignTraces(sweeps, signals, 'union', 'nan', log)
          : mappingAlignTraces(sweeps, signals, 'overlap', 'nan', log);
      log(`对齐了 ${files.length} 条曲线，${A.sweep.length} 个点，范围 [${A.sweep[0].toFixed(4)}, ${A.sweep[A.sweep.length - 1].toFixed(4)}]`);
      let data = A.aligned;
      if (s.log) data = data.map(logAbs);
      // NaN fill on the aligned traces, before gridding
      if (s.nanFill !== 'nan') {
        const all = new Float64Array(data.reduce((n, a) => n + a.length, 0));
        let o = 0; for (const a of data) { all.set(a, o); o += a.length; }
        let lo = Infinity, hi = -Infinity;
        for (const v of all) if (!Number.isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        const v = s.nanFill === 'zero' ? 0 : s.nanFill === 'max' ? hi : lo;
        data = data.map(a => Float64Array.from(a, x => (Number.isNaN(x) ? v : x)));
      }
      if (s.yInterp === 'discrete') {
        discrete = true;
        const nx = A.sweep.length;
        const Z = new Float64Array(nx * params.length);
        data.forEach((a, j) => Z.set(a, j * nx));
        G = { xi: A.sweep, yi: Float64Array.from(params), Z };
        log('Y 方向不插值：每个参数值一行');
      } else {
        G = mappingMake2dGrid(A.sweep, params, data, nGrid, log);
      }
      if (s.transform) {
        if (s.transformMode === 'auto') throw new Error('自动计算比例只能用于双栅模式，请手动填写比例');
        const ratio = Number(s.transformRatio);
        if (!finite(ratio)) throw new Error('变换比例要填数字');
        G = mappingTransformCoords(G, ratio, nGrid, log);
        discrete = false;
        log(`已做坐标变换，比例 r = ${+ratio.toPrecision(6)}`);
      }
    }

    fillNaN(G.Z, s.nanFill);
    const parse = t => (String(t ?? '').trim() === '' ? null : Number(t));
    let vmin = parse(s.vmin), vmax = parse(s.vmax);
    if (!finite(vmin)) vmin = null;
    if (!finite(vmax)) vmax = null;
    const smin = parse(s.sigMin), smax = parse(s.sigMax);
    if (finite(smin)) vmin = smin;
    if (finite(smax)) vmax = smax;
    // show_mapping_window: unset limits come from the 2nd / 98th percentile
    if (vmin === null) vmin = Number.isNaN(nanPercentile(G.Z, 2)) ? 0 : nanPercentile(G.Z, 2);
    if (vmax === null) vmax = Number.isNaN(nanPercentile(G.Z, 98)) ? 1 : nanPercentile(G.Z, 98);
    let zlabel = s.zlabel || '';
    if (s.log && !zlabel.startsWith('log')) zlabel = `log10(|${zlabel}|)`;
    return { xi: G.xi, yi: G.yi, Z: G.Z, nx: G.xi.length, ny: G.yi.length, vmin, vmax, zlabel, discrete };
  }

  // ---------------------------------------------------------------- colormaps
  // A colormap is 256 [r, g, b] entries in 0..1, like a matplotlib LUT.
  function lutFromHex(hex) {
    const out = [];
    for (let i = 0; i < hex.length; i += 6) out.push([0, 2, 4].map(o => parseInt(hex.substr(i + o, 2), 16) / 255));
    return out;
  }
  // Colormap.__call__ for a float in [0, 1]
  const sample = (lut, x) => lut[Math.min(lut.length - 1, Math.max(0, Math.floor(x * lut.length)))];
  // LinearSegmentedColormap.from_list(stops, N=n)
  function fromStops(stops, n = 256) {
    const out = [];
    for (let k = 0; k < n; k++) {
      const x = n === 1 ? 0 : k / (n - 1);
      let s = 1;
      while (s < stops.length - 1 && stops[s][0] < x) s++;
      const [p0, c0] = stops[s - 1], [p1, c1] = stops[s];
      const f = p1 > p0 ? Math.min(1, Math.max(0, (x - p0) / (p1 - p0))) : 0;
      out.push([0, 1, 2].map(i => c0[i] + f * (c1[i] - c0[i])));
    }
    return out;
  }
  const fromList = (colors, n = 256) => fromStops(colors.map((c, i) => [colors.length === 1 ? 0 : i / (colors.length - 1), c]), n);
  // _truncate_colormap
  function truncateLut(lut, low, high, n = 256) {
    const colors = Array.from(linspace(low, high, n), x => sample(lut, x));
    return fromList(colors, n);
  }
  // _build_custom_colormap
  function customLut(low, high, mid, midPos) {
    if (!mid) return fromStops([[0, low], [1, high]]);
    const p = Math.min(Math.max(midPos, 0.001), 0.999);
    return fromStops([[0, low], [p, mid], [1, high]]);
  }
  // _load_cmap_pal: RIFF .pal, JASC-PAL or plain "R G B" lines
  function parsePal(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const tag = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
    let colors = null;
    if (tag(0, 4) === 'RIFF' && tag(8, 4) === 'PAL ') {
      let pos = 12;
      while (pos + 8 <= u8.length) {
        const size = dv.getUint32(pos + 4, true);
        if (tag(pos, 4) === 'data') {
          const count = dv.getUint16(pos + 10, true);
          colors = [];
          for (let i = 0; i + 3 < 4 * count; i += 4) colors.push([u8[pos + 12 + i], u8[pos + 13 + i], u8[pos + 14 + i]]);
          break;
        }
        pos += 8 + size + (size & 1);
      }
    } else {
      let lines = new TextDecoder().decode(u8).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length && lines[0].toUpperCase() === 'JASC-PAL') lines = lines.slice(3);
      colors = [];
      for (const l of lines) {
        const p = l.replace(/,/g, ' ').split(/\s+/);
        if (p.length >= 3) { const v = p.slice(0, 3).map(Number); if (v.every(finite)) colors.push(v.map(Math.trunc)); }
      }
    }
    if (!colors || colors.length < 2) throw new Error('文件里没有找到色标颜色');
    return fromList(colors.map(c => c.map(v => Math.min(1, Math.max(0, v / 255)))), Math.max(256, colors.length));
  }
  // _export_cmap_origin_pal: Origin RIFF palette, 256 entries
  function exportPal(lut, n = 256) {
    const buf = new ArrayBuffer(24 + 4 * n), dv = new DataView(buf), u8 = new Uint8Array(buf);
    const put = (o, s) => { for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i); };
    put(0, 'RIFF'); dv.setUint32(4, 24 + 4 * n - 8, true); put(8, 'PAL '); put(12, 'data');
    dv.setUint32(16, 24 + 4 * n - 20, true); u8[20] = 0; u8[21] = 3; dv.setUint16(22, n, true);
    for (let i = 0; i < n; i++) {
      const c = sample(lut, n === 1 ? 0 : i / (n - 1));
      for (let k = 0; k < 3; k++) u8[24 + 4 * i + k] = Math.floor(c[k] * 255);
    }
    return u8;
  }
  const plotlyScale = lut => lut.map((c, i) => [i / (lut.length - 1), `rgb(${c.map(v => Math.round(v * 255)).join(',')})`]);

  // _parse_color_text: "R,G,B" (0-255), "#rrggbb" or "rrggbb"
  function parseColor(text) {
    const t = String(text || '').trim();
    const parts = t.replace(/，/g, ',').replace(/;/g, ',').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    if (parts.length === 3) {
      const v = parts.map(Number);
      if (v.every(finite)) return v.every(a => a >= 0 && a <= 255) ? v.map(a => a / 255) : null;
    }
    const m = /^#?([0-9a-f]{6})$/i.exec(t);
    return m ? [0, 2, 4].map(o => parseInt(m[1].substr(o, 2), 16) / 255) : null;
  }
  const rgbHex = c => '#' + c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  const rgbText = c => c.map(v => Math.round(v * 255)).join(',');

  // _sig_round
  const sigRound = v => (v === 0 || !finite(v) ? v : Number(v.toPrecision(8)));

  // export_data: matrix with Y down the side and X across the top
  function mappingMatrix(M, swapped) {
    const { xi, yi, Z, nx, ny } = M;
    const rows = [], xs = swapped ? yi : xi, ys = swapped ? xi : yi;
    rows.push(['Y_param', ...Array.from(xs, sigRound)]);
    for (let r = 0; r < ys.length; r++) {
      const row = [sigRound(ys[r])];
      for (let c = 0; c < xs.length; c++) row.push(swapped ? Z[c * nx + r] : Z[r * nx + c]);
      rows.push(row);
    }
    return rows;
  }

  Object.assign(DP, {
    mapping: {
      mappingSymmetrize, mappingAntiSymmetrize, mappingSubtractBackground, mappingAlignTraces,
      griddata, mappingGridScattered, mappingMake2dGrid, mappingCalcSweepRatio, mappingTransformCoords,
      computeMapping, nanPercentile,
      lutFromHex, truncateLut, customLut, parsePal, exportPal, plotlyScale, sample,
      parseColor, rgbHex, rgbText, mappingMatrix, sigRound,
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
