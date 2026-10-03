import { floors, buildingHeight as heightForCount, cityLayout, projectPoint, BLOCK } from './model.js';
/** Canvas-only artwork; all meaning and keyboard interaction are supplied by React. */
export function createCityRenderer(canvas, root) {
  const ctx = canvas.getContext('2d');
  if (!ctx)
    return null;
  let projects = [], selected = '', width = 1120, height = 775, scale = 1, time = 0, motion = true, hitAreas = [], colors = {}, dpr = 1;
  let layout = cityLayout([]), originU = 0, originV = 0;
  function refreshPalette() {
    const probe = document.createElement('span');
    root.appendChild(probe);
    for (const k of ['ground', 'groundside', 'groundfront', 'grass', 'lawn', 'path', 'curb', 'road', 'roadedge', 'stripe', 'tree', 'treebright', 'treedark', 'bark', 'water', 'waterdeep', 'sand', 'facade', 'facadelight', 'facadeside', 'roof', 'trim', 'glass', 'glassdark', 'glasslight', 'warm', 'warmbright', 'purple', 'blue', 'coral', 'mint', 'black', 'white', 'skin', 'shadow']) {
      probe.style.backgroundColor = `var(--zc-${k})`;
      colors[k] = getComputedStyle(probe).backgroundColor;
    }
    probe.remove();
  }
  const C = k => typeof k === 'string' ? (colors[k] || k) : k;
  const P = (u, v, z = 0) => projectPoint(u + originU, v + originV, z);
  function at(u, v, draw) { originU = u; originV = v; draw(); originU = 0; originV = 0; }
  const alpha = (c, a) => { const m = C(c).match(/[\d.]+/g) || ['0', '0', '0']; return 'rgba(' + m.slice(0, 3).join(',') + ',' + a + ')'; };
  function polygon(points, color, stroke = null, lw = 1) { ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath(); ctx.fillStyle = C(color); ctx.fill(); if (stroke) {
    ctx.strokeStyle = C(stroke);
    ctx.lineWidth = lw;
    ctx.stroke();
  } }
  function path(points, color, lw = 1) { ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.strokeStyle = C(color); ctx.lineWidth = lw; ctx.stroke(); }
  function plane(u, v, w, d, z, color, stroke = null, lw = 1) { polygon([P(u, v, z), P(u + w, v, z), P(u + w, v + d, z), P(u, v + d, z)], color, stroke, lw); }
  function prism(u, v, w, d, h, z, top = 'facadelight', front = 'facade', side = 'facadeside') {
    polygon([P(u, v + d, z), P(u + w, v + d, z), P(u + w, v + d, z + h), P(u, v + d, z + h)], front);
    polygon([P(u + w, v, z), P(u + w, v + d, z), P(u + w, v + d, z + h), P(u + w, v, z + h)], side);
    plane(u, v, w, d, z + h, top);
  }
  function ellipse(x, y, rx, ry, c) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = C(c); ctx.fill(); }
  function round(x, y, w, h, r, c) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fillStyle = C(c); ctx.fill(); }
  function groundShadow(u, v, w, d) { ctx.save(); ctx.filter = 'blur(5px)'; plane(u + 8, v + 9, w + 13, d + 10, 0, alpha('shadow', .16)); ctx.restore(); }
  function ovalGround(u, v, w, d, color) { const c = P(u, v); ctx.save(); ctx.translate(...c); ctx.transform(.72, .35, -.72, .35, 0, 0); ellipse(0, 0, w, d, color); ctx.restore(); }
  function tree(u, v, s = 1, z = 0) { const [x, y] = P(u, v, z); if (z === 0)
    ovalGround(u + 7, v + 6, 17 * s, 15 * s, alpha('shadow', .17)); round(x - 2 * s, y - 28 * s, 5 * s, 31 * s, 2 * s, 'bark'); ellipse(x, y - 37 * s, 19 * s, 24 * s, 'treedark'); ellipse(x - 5 * s, y - 43 * s, 17 * s, 20 * s, 'tree'); ellipse(x - 8 * s, y - 48 * s, 11 * s, 11 * s, 'treebright'); ellipse(x + 10 * s, y - 35 * s, 11 * s, 15 * s, 'tree'); }
  function bush(u, v, w = 20, d = 12, z = 0) { prism(u, v, w, d, 5, z, 'curb', 'bark', 'bark'); for (let i = 0; i < 3; i++) {
    const p = P(u + 5 + i * w / 3, v + d / 2, z + 8);
    ellipse(p[0], p[1], 7, 7, i % 2 ? 'tree' : 'treedark');
  } }
  function person(u, v, c = 'purple', walk = false, z = 0) { const [x, y] = P(u, v, z), step = walk ? Math.sin(time * 8 + u) * 1.4 : 0; ellipse(x, y + 1, 5, 2, alpha('shadow', .18)); round(x - 3, y - 4 + step, 2.7, 6, 1, 'black'); round(x + 1, y - 4 - step, 2.7, 6, 1, 'black'); round(x - 5, y - 14, 10, 11, 3, c); round(x - 6, y - 12 + step, 2.5, 7, 1, 'skin'); round(x + 4, y - 12 - step, 2.5, 7, 1, 'skin'); round(x - 3.7, y - 21, 7.5, 8, 3, 'skin'); round(x - 4, y - 22, 8, 4, 2, 'black'); }
  function lamp(u, v) { const [x, y] = P(u, v); ellipse(x + 3, y + 1, 5, 2, alpha('shadow', .14)); path([[x, y], [x, y - 34], [x + 7, y - 37]], 'black', 2); ellipse(x + 8, y - 36, 4, 2, 'warmbright'); const glow = ctx.createRadialGradient(x + 8, y - 32, 0, x + 8, y - 32, 16); glow.addColorStop(0, alpha('warm', .17)); glow.addColorStop(1, alpha('warm', 0)); ellipse(x + 8, y - 32, 16, 16, glow); }
  function bench(u, v) { prism(u, v, 29, 10, 4, 3, 'bark', 'bark', 'black'); prism(u, v + 8, 29, 3, 10, 6, 'bark', 'bark', 'bark'); prism(u + 3, v + 1, 3, 6, 5, 0, 'black', 'black', 'black'); prism(u + 23, v + 1, 3, 6, 5, 0, 'black', 'black', 'black'); }
  function faceWindow(u, v, w, z, h, lit, needs = false, side = false) {
    const a = P(u, v, z), b = side ? P(u, v + w, z) : P(u + w, v, z), c = side ? P(u, v + w, z + h) : P(u + w, v, z + h), d = P(u, v, z + h);
    polygon([a, b, c, d], lit ? 'warm' : 'glassdark');
    polygon([side ? P(u, v + 2, z + h - 3) : P(u + 2, v, z + h - 3), side ? P(u, v + w - 2, z + h - 3) : P(u + w - 2, v, z + h - 3), side ? P(u, v + w - 2, z + h * .45) : P(u + w - 2, v, z + h * .45), side ? P(u, v + 2, z + h * .45) : P(u + 2, v, z + h * .45)], lit ? 'warmbright' : 'glass');
    if (lit && !needs) {
      const mid = side ? P(u, v + w * .5, z + 3) : P(u + w * .5, v, z + 3);
      round(mid[0] - 2, mid[1] - 5, 4, 5, 1, alpha('bark', .4));
      ellipse(mid[0], mid[1] - 6, 1.6, 1.6, alpha('bark', .5));
    }
    if (needs) {
      const q = side ? P(u, v + w / 2, z + h / 2) : P(u + w / 2, v, z + h / 2);
      round(q[0] - 1, q[1] - 4, 2, 6, 1, 'black');
      ellipse(q[0], q[1] + 4, 1.2, 1.2, 'black');
    }
  }
  const buildingHeight = p => heightForCount(p.count);
  function projectBuilding(p) {
    const { u, v, w, d } = p, f = floors(p.count), h = buildingHeight(p);
    groundShadow(u, v, w, d);
    if (selected === p.id)
      plane(u - 9, v - 9, w + 18, d + 18, 1, alpha(p.color, .20), alpha(p.color, .75), 2);
    prism(u - 2, v - 2, w + 4, d + 4, 6, 0, 'path', 'curb', 'curb');
    prism(u, v, w, d, h, 6, 'roof', p.variant === 2 ? 'sand' : 'facade', p.variant === 1 ? 'glasslight' : 'facadeside');
    for (let n = 0; n < f; n++) {
      const z = 40 + n * 24;
      prism(u - 2, v - 1, w + 4, d + 3, 3, z, 'trim', 'facadelight', 'facadeside');
      for (let col = 0; col < 4; col++) {
        const index = n * 4 + col, exists = index < p.count, lit = exists && index < p.working, needs = exists && index >= p.working && index < p.working + p.needs;
        faceWindow(u + 12 + col * (w - 17) / 4, v + d + .1, 22, z + 5, 15, lit || needs, needs);
      }
      for (let col = 0; col < 3; col++)
        faceWindow(u + w + .1, v + 10 + col * (d - 15) / 3, 18, z + 5, 15, n * 3 + col < p.working, false, true);
    }
    prism(u - 3, v - 3, w + 6, d + 6, 5, h + 6, p.color, 'facadelight', p.color);
    prism(u + 8, v + 8, w - 16, d - 16, 4, h + 11, 'roof', 'trim', 'trim');
    const doorU = u + w * .42;
    faceWindow(doorU, v + d + .3, 30, 6, 31, false);
    path([P(doorU + 15, v + d + .5, 6), P(doorU + 15, v + d + .5, 37)], 'glasslight', 1);
    prism(doorU - 9, v + d - 1, 47, 19, 3, 39, p.color, p.color, 'facadeside');
    prism(doorU - 14, v + d, 55, 14, 3, 2, 'path', 'curb', 'curb');
    bush(u + 8, v + d + 4, 24, 12);
    bush(u + w - 35, v + d + 4, 24, 12);
    if (p.variant === 0) {
      plane(u + 16, v + 16, 74, 56, h + 15, 'grass');
      bush(u + 22, v + 21, 56, 16, h + 15);
      tree(u + 67, v + 52, .45, h + 17);
      prism(u + 108, v + 21, 39, 36, 13, h + 15, 'facadelight', 'trim', 'facadeside');
      for (let i = 0; i < 4; i++)
        path([P(u + 114 + i * 7, v + 25, h + 29), P(u + 114 + i * 7, v + 51, h + 29)], 'roof', 1.5);
      const q = P(u + 133, v + 85, h + 17);
      path([[q[0], q[1]], [q[0], q[1] - 21]], 'black', 2);
      ellipse(q[0], q[1] - 23, 2, 2, 'warm');
    }
    else if (p.variant === 1) {
      for (let i = 0; i < 3; i++) {
        prism(u + 21 + i * 36, v + 19, 29, 47, 3, h + 15, 'glassdark', 'glass', 'glass');
        for (let j = 1; j < 3; j++)
          path([P(u + 21 + i * 36 + j * 9, v + 20, h + 19), P(u + 21 + i * 36 + j * 9, v + 65, h + 19)], 'glasslight', .8);
      }
      bush(u + 27, v + 78, 89, 12, h + 15);
    }
    else {
      prism(u + 18, v + 16, 34, 27, 15, h + 15, 'sand', 'facade', 'facadeside');
      prism(u + 75, v + 20, 24, 25, 17, h + 15, 'coral', 'coral', 'bark');
      for (let i = 0; i < 5; i++)
        prism(u + 10 + i * 22, v + d, 19, 23, 2, 35, i % 2 ? 'white' : 'mint', 'facade', 'facadeside');
    }
    const pts = [P(u, v, h + 38), P(u + w, v, h + 12), P(u + w, v + d, 0), P(u, v + d, 0)];
    hitAreas.push({ id: p.id, x: Math.min(...pts.map(p => p[0])), y: Math.min(...pts.map(p => p[1])), w: Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0])), h: Math.max(...pts.map(p => p[1])) - Math.min(...pts.map(p => p[1])) });
  }
  function roads() {
    for (let row = 0; row <= layout.rows; row++) {
      const v = row * BLOCK;
      plane(0, v, layout.width, 56, 1, 'curb');
      plane(0, v + 5, layout.width, 46, 2, 'path');
      plane(0, v + 12, layout.width, 32, 3, 'road');
      for (let u = 20; u < layout.width - 20; u += 36) plane(u, v + 27, 18, 2, 4, 'stripe');
    }
    for (let col = 0; col <= layout.cols; col++) {
      const u = col * BLOCK;
      if (u > layout.width - 50) continue;
      plane(u, 0, 56, layout.frontage + 56, 1, 'curb');
      plane(u + 5, 0, 46, layout.frontage + 56, 2, 'path');
      plane(u + 12, 0, 32, layout.frontage + 56, 3, 'road');
      for (let v = 65; v < layout.frontage; v += 36) if (v % BLOCK > 55) plane(u + 27, v, 2, 18, 4, 'stripe');
      for (let row = 0; row <= layout.rows; row++) for (let n = 0; n < 5; n++) plane(u + 58 + n * 5, row * BLOCK + 13, 3, 30, 5, 'stripe');
    }
  }
  function rails() {
    const v = layout.frontage + 174;
    plane(4, v, layout.width - 8, 36, 1, 'groundside');
    plane(4, v + 3, layout.width - 8, 30, 2, 'curb');
    for (let u = 6; u < layout.width - 8; u += 12) plane(u, v + 5, 4, 26, 3, 'bark');
    for (const offset of [9, 27]) { plane(4, v + offset, layout.width - 8, 2, 5, 'glassdark'); plane(4, v + offset, layout.width - 8, 1, 6, 'trim'); }
  }
  function parkGround() { plane(30, 335, 243, 143, 1, 'path'); plane(37, 342, 228, 129, 2, 'grass'); plane(49, 354, 205, 105, 3, 'lawn'); plane(141, 342, 17, 129, 4, 'path'); plane(49, 415, 205, 13, 4, 'path'); ovalGround(105, 390, 43, 29, 'waterdeep'); ovalGround(101, 386, 37, 24, 'water'); ovalGround(91, 379, 22, 2, alpha('white', .4)); ovalGround(104, 393, 18, 1, alpha('white', .3)); bench(73, 446); bench(204, 374); for (let i = 0; i < 6; i++) {
    const p = P(190 + i * 7, 445 + Math.sin(i) * 3, 6);
    ellipse(...p, 2.3, 2.3, i % 2 ? 'coral' : 'warm');
  } }
  function civic(u, v, w, d, h, color, id) { groundShadow(u, v, w, d); prism(u - 5, v - 5, w + 10, d + 10, 6, 0, 'path', 'curb', 'curb'); prism(u, v, w, d, h, 6, 'roof', 'sand', 'facadeside'); prism(u - 5, v - 5, w + 10, d + 10, 7, h + 6, color, 'facadelight', color); for (let n = 0; n < 3; n++)
    faceWindow(u + 13 + n * (w - 20) / 3, v + d, 19, 15, 28, true); faceWindow(u + w * .45, v + d + .2, 25, 6, 29, false); bush(u + 3, v + d + 5, 22, 10); const a = P(u, v, h + 20), b = P(u + w, v + d); hitAreas.push({ id, x: P(u, v + d)[0], y: a[1], w: (w + d) * .72, h: b[1] - a[1] + 15 }); }
  function station() { const u = 262, v = 407, w = 152, d = 75; plane(u - 5, v + d, 173, 15, 2, 'path'); civic(u, v, w, d, 58, 'blue', 'station'); prism(u + 8, v + d - 4, w - 16, 23, 4, 45, 'blue', 'white', 'blue'); for (let i = 0; i < 4; i++)
    prism(u + 15 + i * 39, v + d + 13, 2, 2, 39, 4, 'white', 'white', 'white'); prism(u + 59, v + 8, 35, 34, 43, 65, 'blue', 'sand', 'facadeside'); const c = P(u + 76, v + 43, 88); ellipse(c[0], c[1], 10, 10, 'black'); ellipse(c[0], c[1], 8.5, 8.5, 'white'); path([[c[0], c[1] - 5], [c[0], c[1]], [c[0] + 4, c[1] + 2]], 'black', 1.3); for (let i = 0; i < 4; i++)
    bush(u - 7 + i * 43, v - 13, 24, 9); }
  function library() { const u = 600, v = 355, w = 103, d = 80; civic(u, v, w, d, 62, 'coral', 'library'); prism(u + 17, v + 17, 69, 41, 7, 75, 'coral', 'coral', 'bark'); for (let i = 0; i < 3; i++)
    prism(u + 24 + i * 19, v + 24, 11, 24, 4, 84, 'warm', 'sand', 'sand'); const mail = P(u + w + 9, v + d - 9); round(mail[0] - 3, mail[1] - 12, 7, 13, 2, 'mint'); round(mail[0] - 4, mail[1] - 13, 9, 5, 2, 'mint'); }
  function car(u, v, c = 'coral', bus = false, axis = 'u') {
    const w = bus ? 63 : 32, d = bus ? 23 : 19, h = bus ? 15 : 9;
    const world = (a, b, z) => axis === 'v' ? P(u + b, v + a, z) : P(u + a, v + b, z);
    const block = (a, b, ww, dd, hh, z, top, front, side) => { polygon([world(a, b + dd, z), world(a + ww, b + dd, z), world(a + ww, b + dd, z + hh), world(a, b + dd, z + hh)], front); polygon([world(a + ww, b, z), world(a + ww, b + dd, z), world(a + ww, b + dd, z + hh), world(a + ww, b, z + hh)], side); polygon([world(a, b, z + hh), world(a + ww, b, z + hh), world(a + ww, b + dd, z + hh), world(a, b + dd, z + hh)], top); };
    polygon([world(-2, 0, 3), world(w + 4, 0, 3), world(w + 4, d + 6, 3), world(-2, d + 6, 3)], alpha('shadow', .15));
    for (const a of [6, w - 7]) {
      const q = world(a, d + 1, 6);
      ellipse(q[0], q[1], 3, 4, 'black');
      ellipse(q[0], q[1], 1.3, 2, 'trim');
    }
    block(0, 0, w, d, h, 7, c, c, c);
    block(bus ? 3 : 7, 2, bus ? w - 6 : 18, d - 4, 7, 7 + h, bus ? 'white' : c, 'glassdark', 'glass');
    if (bus)
      for (let n = 0; n < 5; n++)
        polygon([world(7 + n * 10, d - 1, 18), world(14 + n * 10, d - 1, 18), world(14 + n * 10, d - 1, 24), world(7 + n * 10, d - 1, 24)], 'glasslight');
    for (const b of [3, d - 4]) {
      const q = world(w + .5, b, 11);
      ellipse(q[0], q[1], 1.6, 1.8, 'warmbright');
    }
  }
  function train(u) { for (let n = 2; n >= 0; n--) {
    const x = u - n * 79, v = layout.frontage + 180, w = 73, d = 24;
    if (x < 6 || x + w > layout.width - 6)
      continue;
    groundShadow(x, v, w, d);
    prism(x, v, w, d, 19, 8, 'mint', 'mint', 'treedark');
    prism(x + 3, v + 2, w - 6, d - 4, 4, 27, 'white', 'white', 'trim');
    for (let j = 0; j < 5; j++)
      faceWindow(x + 7 + j * 12, v + d + .2, 8, 16, 9, true);
    prism(x + w - 3, v + 5, 3, d - 10, 10, 13, 'glass', 'glass', 'glass');
    for (let j = 0; j < 2; j++) {
      const q = P(x + 12 + j * 45, v + d + 1, 8);
      ellipse(q[0], q[1], 3.5, 4.2, 'black');
    }
    if (n < 2)
      prism(x - 6, v + 8, 6, 7, 3, 13, 'black', 'black', 'black');
  } }
  function tinyText(s, u, v, z, color = 'black', size = 11) { if (scale * layout.scale < .46)
    return; const p = P(u, v, z); ctx.font = (size / (scale * layout.scale)) + 'px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif'; ctx.fillStyle = C(color); ctx.textAlign = 'center'; ctx.fillText(s, ...p); ctx.textAlign = 'start'; }
  function renderCity() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(layout.x, layout.y);
    ctx.scale(layout.scale, layout.scale);
    hitAreas = [];
    ctx.save(); ctx.filter = 'blur(17px)';
    plane(0, 8, layout.width + 7, layout.depth + 2, -28, alpha('shadow', .18));
    ctx.restore();
    prism(0, 0, layout.width, layout.depth, 15, -15, 'ground', 'groundfront', 'groundside');
    roads(); rails();
    at(35, -265, parkGround);
    for (const p of projects) {
      plane(p.u - 10, p.v - 10, 218, 211, 1, 'path');
      plane(p.u - 5, p.v - 5, 208, 201, 2, p.lot % 2 ? 'lawn' : 'grass');
    }
    const objects = [];
    for (const p of projects)
      objects.push({ depth: p.u + p.v + (p.w + p.d) * .5, fn: () => projectBuilding(p) });
    objects.push(
      { depth: 155 + layout.frontage + 110, fn: () => at(-180, layout.frontage - 337, station) },
      { depth: 415 + layout.frontage + 105, fn: () => at(-240, layout.frontage - 280, library) }
    );
    for (const [u, v, size] of [[82, 82, 1], [277, 94, .9], [85, 200, .85], [274, 210, .8]]) objects.push({ depth: u + v, fn: () => tree(u, v, size) });
    for (const p of projects) {
      for (const [u, v] of [[p.u + 197, p.v + 40], [p.u + 197, p.v + 155]]) objects.push({ depth: u + v, fn: () => tree(u, v, .8) });
      objects.push({ depth: p.u + p.v + 222, fn: () => lamp(p.u + 30, p.v + 192) });
    }
    let citizenCount = 0;
    for (const p of projects) {
      // A bounded set of real members is animated; the complete roster remains accessible.
      p.members.slice(0, Math.max(1, Math.min(12, Math.floor(180 / Math.max(projects.length, 1))))).forEach((member, i) => {
        if (citizenCount++ >= 180) return;
        const idle = member.status === 'idle', done = !member.live;
        const citizenIndex = citizenCount - 1;
        const u = done ? 365 + (citizenIndex % 8) * 13 : idle ? 105 + (citizenIndex % 8) * 19 : p.u + 18 + (i % 5) * 23;
        const v = done ? layout.frontage + 165 + (Math.floor(citizenIndex / 8) % 2) * 6 : idle ? 110 + (Math.floor(citizenIndex / 8) % 6) * 22 : p.v + p.d + 30 + Math.floor(i / 5) * 17;
        const walking = member.status === 'working';
        const uu = u + (walking ? Math.sin(time * .65 + i) * 9 : 0);
        objects.push({ depth: uu + v, fn: () => {
            person(uu, v, member.status === 'needs-you' || member.status === 'error' ? 'coral' : done ? 'mint' : p.color, walking && motion);
            const q = P(uu, v);
            if (member.status === 'needs-you') {
              round(q[0] - 4, q[1] - 35, 8, 10, 3, 'warm');
              tinyText('!', uu, v, 27, 'black', 9);
            }
            hitAreas.push({ id: member.key, x: q[0] - 7, y: q[1] - 27, w: 14, h: 29 });
          } });
      });
    }
    for (let row = 0; row <= layout.rows; row++) {
      const span = layout.width - 90, u = 10 + (time * 24 + row * 217) % span, v = row * BLOCK + 17;
      objects.push({ depth: u + v + 25, fn: () => car(u, v, row % 2 ? 'blue' : 'coral', row === layout.rows) });
    }
    objects.sort((a, b) => a.depth - b.depth);
    for (const o of objects)
      o.fn();
    train(230 + (time * 40) % Math.max(500, layout.width));
    tinyText('THE COMMONS', 185, 242, 0, 'treedark', 11);
    tinyText('SCHEDULER', 170, layout.frontage + 168, 4, 'black', 11);
    tinyText('DONE', 410, layout.frontage + 168, 5, 'black', 11);
    ctx.restore();
  }
  refreshPalette();
  return {
    refreshPalette,
    draw(buildings, selection, elapsed, animate) {
      projects = buildings;
      selected = selection;
      time = elapsed;
      motion = animate;
      width = canvas.clientWidth || 1120;
      height = canvas.clientHeight || width * 775 / 1120;
      scale = 1;
      layout = cityLayout(buildings, width, height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      renderCity();
    },
    hit(x, y) {
      const worldX = (x / scale - layout.x) / layout.scale, worldY = (y / scale - layout.y) / layout.scale;
      const a = [...hitAreas].reverse().find((a) => worldX >= a.x && worldX <= a.x + a.w && worldY >= a.y && worldY <= a.y + a.h);
      return a?.id;
    }
  };
}
