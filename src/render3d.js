/*
 * render3d.js — the river in three dimensions, on Three.js.
 *
 * A drop-in for render.js: same constructor, same five members main.js uses
 * (toWorld, resize, update, draw, game). Everything the physics knows lives in
 * the plane z = 0; this file gives that plane a riverbed beneath it, banks on
 * either side, a sky above, and water that actually behaves like a surface —
 * Fresnel, specular, moving normals — instead of a flat blue rectangle.
 *
 * Nothing here is loaded from a network: three.js is vendored, every texture
 * is generated on a canvas, and every mesh is built from the same numbers the
 * simulation runs on (river.bedY, rig.nodes, fish.lengthCm).
 */
(function (EN) {
  'use strict';

  var W = EN.WORLD;
  var T = window.THREE;

  // ---- small helpers -------------------------------------------------------

  /** Deterministic PRNG so scatter never shimmers between frames or builds. */
  function seeded(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function hex(h) { return new T.Color(h); }

  // ---- procedural textures ---------------------------------------------------
  // Everything is baked on a canvas at start-up: there are no image files in
  // the build, so gravel, rock, grass, foliage and the water's ripple normals
  // all come out of noise. Every map tiles.

  /** Periodic lattice value noise, so the tile wraps. */
  function pnoise(x, y, period, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    function h(i, j) {
      i = ((i % period) + period) % period; j = ((j % period) + period) % period;
      var n = (i * 374761393 + j * 668265263 + (seed || 0) * 1274126177) | 0;
      n = (n ^ (n >> 13)) * 1274126177;
      return ((n ^ (n >> 16)) >>> 0) / 4294967296;
    }
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return (h(xi, yi) * (1 - u) + h(xi + 1, yi) * u) * (1 - v)
         + (h(xi, yi + 1) * (1 - u) + h(xi + 1, yi + 1) * u) * v;
  }
  /** Tileable fbm over the unit tile: u, v in [0,1). */
  function fbm(u, v, base, octaves, seed, gain) {
    var a = 0.5, f = base, sum = 0, norm = 0;
    gain = gain || 0.5;
    for (var o = 0; o < octaves; o++) {
      sum += a * pnoise(u * f, v * f, f, seed + o * 7);
      norm += a; a *= gain; f *= 2;
    }
    return sum / norm;
  }

  /**
   * Tileable pebble field: one jittered feature point per grid cell, each
   * pixel takes the nearest two. Returns per-pixel dome height, cell id and
   * a crevice weight.
   */
  function pebbleField(size, cells, seed) {
    var rnd = seeded(seed);
    var px = new Float32Array(cells * cells), py = new Float32Array(cells * cells), pr = new Float32Array(cells * cells);
    for (var i = 0; i < cells * cells; i++) { px[i] = rnd(); py[i] = rnd(); pr[i] = 0.55 + rnd() * 0.45; }
    var height = new Float32Array(size * size), id = new Int32Array(size * size), crev = new Float32Array(size * size);
    var cellSize = 1 / cells;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var u = x / size, v = y / size;
        var cx = Math.floor(u * cells), cy = Math.floor(v * cells);
        var f1 = 9, f2 = 9, best = 0;
        for (var oy = -1; oy <= 1; oy++) {
          for (var ox = -1; ox <= 1; ox++) {
            var gx = cx + ox, gy = cy + oy;
            var wx = ((gx % cells) + cells) % cells, wy = ((gy % cells) + cells) % cells;
            var k = wy * cells + wx;
            var fx = (gx + px[k]) * cellSize, fy = (gy + py[k]) * cellSize;
            var d = Math.hypot(u - fx, v - fy) / (cellSize * pr[k]);
            if (d < f1) { f2 = f1; f1 = d; best = k; } else if (d < f2) f2 = d;
          }
        }
        var n = y * size + x;
        var dome = Math.max(0, 1 - f1 * f1 * 0.85);
        height[n] = Math.sqrt(dome);
        id[n] = best;
        crev[n] = clamp((f2 - f1) * 2.2, 0, 1);
      }
    }
    return { height: height, id: id, crev: crev, count: cells * cells };
  }

  /** Tangent-space normal map from a tileable height field. */
  function normalFromHeight(height, size, strength) {
    var c = document.createElement('canvas'); c.width = size; c.height = size;
    var g = c.getContext('2d');
    var img = g.createImageData(size, size);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var l = height[y * size + (x + size - 1) % size], r = height[y * size + (x + 1) % size];
        var d = height[((y + 1) % size) * size + x], u = height[((y + size - 1) % size) * size + x];
        var nx = (l - r) * strength, ny = (d - u) * strength, nz = 1;
        var len = Math.hypot(nx, ny, nz);
        var k = (y * size + x) * 4;
        img.data[k] = 128 + nx / len * 127; img.data[k + 1] = 128 + ny / len * 127; img.data[k + 2] = 128 + nz / len * 127; img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    var tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    return tex;
  }
  function canvasTex(c, srgb) {
    var tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    if (srgb) tex.colorSpace = T.SRGBColorSpace;
    return tex;
  }
  function rgb(r, g, b) { return [r, g, b]; }
  function mixc(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  /**
   * A gravel bed: rounded stones of mixed colour packed in dark grit, with a
   * normal map for the domes and a roughness map that leaves the stone tops
   * smoother (wet) than the grit between them.
   */
  function bakeGravel(size, cells, seed, palette, gritColor, dry) {
    var f = pebbleField(size, cells, seed);
    var rnd = seeded(seed + 3);
    var stoneCol = [];
    for (var i = 0; i < f.count; i++) {
      var base = palette[Math.floor(rnd() * palette.length)];
      var shade = 0.8 + rnd() * 0.4;
      stoneCol.push([base[0] * shade, base[1] * shade, base[2] * shade]);
    }
    var c = document.createElement('canvas'); c.width = size; c.height = size;
    var g = c.getContext('2d'); var img = g.createImageData(size, size);
    var rc = document.createElement('canvas'); rc.width = size; rc.height = size;
    var rg = rc.getContext('2d'); var rimg = rg.createImageData(size, size);
    var h = new Float32Array(size * size);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var n = y * size + x, u = x / size, v = y / size;
        var grain = fbm(u, v, 24, 3, seed + 11);
        var dome = f.height[n];
        var col = mixc(gritColor, stoneCol[f.id[n]], smooth(0.15, 0.45, dome));
        var speck = (fbm(u, v, 96, 2, seed + 5) - 0.5) * 0.18;
        var shade2 = 0.86 + grain * 0.28 + speck;
        col = [col[0] * shade2, col[1] * shade2, col[2] * shade2];
        var k = n * 4;
        img.data[k] = clamp(col[0], 0, 255); img.data[k + 1] = clamp(col[1], 0, 255); img.data[k + 2] = clamp(col[2], 0, 255); img.data[k + 3] = 255;
        h[n] = dome * 0.85 + (grain - 0.5) * 0.12;
        var rough = dry ? 0.82 + (1 - dome) * 0.15 : 0.32 + (1 - dome) * 0.55 + grain * 0.1;
        var rv = clamp(rough, 0, 1) * 255;
        rimg.data[k] = rv; rimg.data[k + 1] = rv; rimg.data[k + 2] = rv; rimg.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0); rg.putImageData(rimg, 0, 0);
    return { map: canvasTex(c, true), normalMap: normalFromHeight(h, size, size * 0.012), roughnessMap: canvasTex(rc, false) };
  }

  /** Weathered rock: ridged fbm cracks, lichen patches, a strong normal map. */
  function bakeRock(size, seed) {
    var c = document.createElement('canvas'); c.width = size; c.height = size;
    var g = c.getContext('2d'); var img = g.createImageData(size, size);
    var h = new Float32Array(size * size);
    var base = rgb(118, 112, 100), dark = rgb(58, 54, 46), lichen = rgb(126, 134, 78), pale = rgb(150, 146, 134);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var n = y * size + x, u = x / size, v = y / size;
        var big = fbm(u, v, 3, 4, seed);
        var ridge = 1 - Math.abs(fbm(u, v, 6, 4, seed + 3) * 2 - 1);
        var crack = smooth(0.82, 0.97, ridge);
        var fine = fbm(u, v, 40, 3, seed + 9);
        var lich = smooth(0.58, 0.72, fbm(u, v, 5, 3, seed + 20));
        var col = mixc(base, pale, big);
        col = mixc(col, dark, crack * 0.8);
        col = mixc(col, lichen, lich * 0.6);
        var sh = 0.85 + fine * 0.3;
        var k = n * 4;
        img.data[k] = col[0] * sh; img.data[k + 1] = col[1] * sh; img.data[k + 2] = col[2] * sh; img.data[k + 3] = 255;
        h[n] = big * 0.5 + fine * 0.15 - crack * 0.5;
      }
    }
    g.putImageData(img, 0, 0);
    return { map: canvasTex(c, true), normalMap: normalFromHeight(h, size, size * 0.02) };
  }

  /** Bank ground: turf and earth, for under the grass. */
  function bakeTurf(size, seed) {
    var c = document.createElement('canvas'); c.width = size; c.height = size;
    var g = c.getContext('2d'); var img = g.createImageData(size, size);
    var h = new Float32Array(size * size);
    var green = rgb(66, 92, 40), dryg = rgb(118, 122, 62), earth = rgb(84, 68, 46), deep = rgb(38, 52, 26);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var n = y * size + x, u = x / size, v = y / size;
        var a = fbm(u, v, 4, 4, seed), b = fbm(u, v, 30, 3, seed + 4), e = fbm(u, v, 7, 3, seed + 8);
        var col = mixc(green, dryg, smooth(0.45, 0.7, a));
        col = mixc(col, deep, smooth(0.5, 0.8, b) * 0.6);
        col = mixc(col, earth, smooth(0.62, 0.8, e));
        var k = n * 4;
        img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = 255;
        h[n] = b * 0.6 + a * 0.2;
      }
    }
    g.putImageData(img, 0, 0);
    return { map: canvasTex(c, true), normalMap: normalFromHeight(h, size, size * 0.006) };
  }

  /** A card of grass blades with alpha, for instanced tufts. */
  function bakeGrassCard(size, seed) {
    var c = document.createElement('canvas'); c.width = size; c.height = size;
    var g = c.getContext('2d');
    g.clearRect(0, 0, size, size);
    var rnd = seeded(seed);
    for (var i = 0; i < 46; i++) {
      var x0 = size * (0.2 + rnd() * 0.6), lean = (rnd() - 0.5) * size * 0.7;
      var hgt = size * (0.45 + rnd() * 0.5), w = size * (0.012 + rnd() * 0.02);
      var gr = 70 + rnd() * 70, rr = 40 + rnd() * 50, bb = 20 + rnd() * 30;
      var grad = g.createLinearGradient(0, size, 0, size - hgt);
      grad.addColorStop(0, 'rgb(' + (rr * 0.5 | 0) + ',' + (gr * 0.55 | 0) + ',' + (bb * 0.5 | 0) + ')');
      grad.addColorStop(1, 'rgb(' + (rr + 40 | 0) + ',' + (gr + 60 | 0) + ',' + (bb | 0) + ')');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(x0 - w, size);
      g.quadraticCurveTo(x0 + lean * 0.3, size - hgt * 0.6, x0 + lean, size - hgt);
      g.quadraticCurveTo(x0 + lean * 0.3 + w * 1.2, size - hgt * 0.6, x0 + w, size);
      g.closePath(); g.fill();
    }
    var tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    tex.wrapS = tex.wrapT = T.ClampToEdgeWrapping;
    return tex;
  }

  /** A broadleaf tree card: trunk, limbs and clumped foliage with alpha. */
  function bakeTreeCard(size, seed) {
    var c = document.createElement('canvas'); c.width = size; c.height = size;
    var g = c.getContext('2d');
    var rnd = seeded(seed);
    g.clearRect(0, 0, size, size);
    // Trunk and limbs.
    g.strokeStyle = '#3b2e22'; g.lineCap = 'round';
    g.lineWidth = size * 0.05;
    g.beginPath(); g.moveTo(size * 0.5, size); g.lineTo(size * 0.5, size * 0.55); g.stroke();
    for (var b = 0; b < 5; b++) {
      g.lineWidth = size * 0.02;
      g.beginPath(); g.moveTo(size * 0.5, size * (0.55 + rnd() * 0.15));
      g.lineTo(size * (0.2 + rnd() * 0.6), size * (0.25 + rnd() * 0.3)); g.stroke();
    }
    // Foliage: many soft clumps, darker underneath, lit on top.
    for (var i = 0; i < 260; i++) {
      var ang = rnd() * Math.PI * 2, rad = Math.sqrt(rnd()) * size * 0.36;
      var x = size * 0.5 + Math.cos(ang) * rad, y = size * 0.36 + Math.sin(ang) * rad * 0.8;
      var r = size * (0.03 + rnd() * 0.05);
      var lit = 1 - (y / size) * 0.9 + (rnd() - 0.5) * 0.3;
      var gr = 60 + lit * 80, rr = 30 + lit * 45, bb = 18 + lit * 20;
      g.fillStyle = 'rgba(' + (rr | 0) + ',' + (gr | 0) + ',' + (bb | 0) + ',' + (0.55 + rnd() * 0.4) + ')';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    var tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    tex.wrapS = tex.wrapT = T.ClampToEdgeWrapping;
    return tex;
  }

  /** Tileable ripple normals for the water, scrolled in two layers. */
  function bakeWaterNormals(size, seed) {
    var h = new Float32Array(size * size);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var u = x / size, v = y / size;
        // Anisotropic: longer along the flow (u) than across.
        var a = fbm(u * 1.0, v * 2.0 % 1, 6, 4, seed, 0.55);
        var b = fbm(u, v, 14, 3, seed + 5, 0.5);
        h[y * size + x] = a * 0.7 + b * 0.3;
      }
    }
    return normalFromHeight(h, size, size * 0.02);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

  /** Cheap value noise on a lattice, for terrain and stone scatter. */
  function noise2(x, z, seed) {
    var xi = Math.floor(x), zi = Math.floor(z);
    var xf = x - xi, zf = z - zi;
    function h(i, j) {
      var n = (i * 374761393 + j * 668265263 + (seed || 0) * 1274126177) | 0;
      n = (n ^ (n >> 13)) * 1274126177;
      return ((n ^ (n >> 16)) >>> 0) / 4294967296;
    }
    var u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    return (h(xi, zi) * (1 - u) + h(xi + 1, zi) * u) * (1 - v)
         + (h(xi, zi + 1) * (1 - u) + h(xi + 1, zi + 1) * u) * v;
  }

  // ---- shaders -------------------------------------------------------------

  var SKY_VERT = [
    'varying vec3 vDir;',
    'void main() {',
    '  vDir = normalize(position);',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');

  // A clear-weather sky: Rayleigh-ish blue overhead falling to a warm haze at
  // the horizon, a sun disc with a soft aureole, and a drifting layer of
  // fair-weather cumulus from value noise projected onto a high plane.
  var SKY_FRAG = [
    'uniform vec3 uSun; uniform float uTime; uniform float uCloud;',
    'varying vec3 vDir;',
    'float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float vnoise(vec2 p) {',
    '  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);',
    '}',
    'float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }',
    'void main() {',
    '  vec3 d = normalize(vDir);',
    '  float h = clamp(d.y, 0.0, 1.0);',
    '  vec3 zenith = vec3(0.16, 0.36, 0.72);',
    '  vec3 mid = vec3(0.50, 0.68, 0.88);',
    '  vec3 horizon = vec3(0.86, 0.88, 0.90);',
    '  vec3 c = mix(horizon, mid, smoothstep(0.0, 0.18, h));',
    '  c = mix(c, zenith, smoothstep(0.12, 0.85, h));',
    '  vec3 s = normalize(uSun);',
    '  float sd = max(dot(d, s), 0.0);',
    '  c += vec3(1.0, 0.93, 0.80) * (pow(sd, 900.0) * 6.0 + pow(sd, 32.0) * 0.20 + pow(sd, 4.0) * 0.06);',
    '  if (d.y > 0.01) {',
    '    vec2 p = d.xz / (d.y + 0.15) * 1.6 + vec2(uTime * 0.008, uTime * 0.003);',
    '    float n = fbm(p * 0.9);',
    '    float cov = smoothstep(0.50 - uCloud * 0.12, 0.72, n);',
    '    float thick = smoothstep(0.55, 0.9, n);',
    '    vec3 cloud = mix(vec3(1.0, 0.99, 0.97), vec3(0.62, 0.66, 0.72), thick);',
    '    cloud += vec3(0.25, 0.2, 0.12) * pow(sd, 6.0);',
    '    float fade = smoothstep(0.01, 0.14, d.y);',
    '    c = mix(c, cloud, cov * fade * 0.92);',
    '  }',
    '  c = mix(c, horizon, smoothstep(0.03, -0.1, d.y));',
    '  gl_FragColor = vec4(c, 1.0);',
    '  #include <tonemapping_fragment>',
    '  #include <colorspace_fragment>',
    '}'
  ].join('\n');

  // Water: long swells displace the mesh; two scrolling normal-map layers make
  // the surface; the colour is what is under it (a refraction pass, absorbed
  // by depth) mixed with what is above it (a planar reflection pass) by
  // Fresnel, plus the sun's glitter.
  var WATER_VERT = [
    'uniform float uTime; uniform float uChop; uniform float uFlow; uniform mat4 uTexMatrix;',
    'varying vec3 vWorld; varying vec2 vSlope; varying vec4 vRefl; varying vec4 vClipPos; varying float vViewZ;',
    'float wave(vec2 p, float t, out vec2 slope) {',
    '  float a1 = 0.012 * uChop, a2 = 0.008 * uChop, a3 = 0.005 * uChop;',
    '  vec2 d1 = normalize(vec2(1.0, 0.25)), d2 = normalize(vec2(0.7, -0.6)), d3 = normalize(vec2(-0.3, 1.0));',
    '  float k1 = 5.2, k2 = 9.0, k3 = 14.0;',
    '  float p1 = dot(d1, p) * k1 - t * (2.2 + uFlow * 2.5);',
    '  float p2 = dot(d2, p) * k2 - t * 3.1;',
    '  float p3 = dot(d3, p) * k3 + t * 2.4;',
    '  float h = a1 * sin(p1) + a2 * sin(p2) + a3 * sin(p3);',
    '  slope = a1 * k1 * cos(p1) * d1 + a2 * k2 * cos(p2) * d2 + a3 * k3 * cos(p3) * d3;',
    '  return h;',
    '}',
    'void main() {',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  vec2 s; float h = wave(wp.xz, uTime, s);',
    '  wp.y += h;',
    '  vWorld = wp.xyz; vSlope = s;',
    '  vRefl = uTexMatrix * wp;',
    '  vec4 mv = viewMatrix * wp;',
    '  vViewZ = -mv.z;',
    '  vClipPos = projectionMatrix * mv;',
    '  gl_Position = vClipPos;',
    '}'
  ].join('\n');

  var WATER_FRAG = [
    '#include <packing>',
    'uniform float uTime; uniform float uChop; uniform float uFlow;',
    'uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSunDir; uniform vec3 uCamPos;',
    'uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;',
    'uniform sampler2D uRefl; uniform sampler2D uRefr; uniform sampler2D uRefrDepth; uniform sampler2D uNormal;',
    'uniform float uAbsorb; uniform float uMurk; uniform float uNear; uniform float uFar; uniform vec2 uRes;',
    'varying vec3 vWorld; varying vec2 vSlope; varying vec4 vRefl; varying vec4 vClipPos; varying float vViewZ;',
    'float viewZ(float d) { return -perspectiveDepthToViewZ(d, uNear, uFar); }',
    'void main() {',
    '  vec2 p = vWorld.xz;',
    '  float t = uTime * (0.6 + uFlow * 0.5);',
    '  vec3 n1 = texture2D(uNormal, p * vec2(0.55, 0.9) + vec2(t * 0.16, t * 0.02)).xyz * 2.0 - 1.0;',
    '  vec3 n2 = texture2D(uNormal, p * vec2(1.7, 2.3) + vec2(t * 0.31, -t * 0.05)).xyz * 2.0 - 1.0;',
    '  vec2 ripple = (n1.xy * 0.7 + n2.xy * 0.5) * (0.45 + uChop * 0.5) * 0.22;',
    '  vec3 n = normalize(vec3(-vSlope.x - ripple.x, 1.0, -vSlope.y - ripple.y));',
    '  vec3 v = normalize(uCamPos - vWorld);',
    '  float dist = length(uCamPos - vWorld);',
    '  vec2 screen = gl_FragCoord.xy / uRes;',
    '  float distAmt = 0.06 / (1.0 + dist * 0.25);',
    '  vec2 dz = n.xz * distAmt;',
    // refraction with a distorted lookup, falling back to the straight one
    // where the distortion reached something standing above the surface.
    '  vec2 ruv = screen + dz;',
    '  float sz = viewZ(texture2D(uRefrDepth, ruv).x);',
    '  if (sz < vViewZ) { ruv = screen; sz = viewZ(texture2D(uRefrDepth, ruv).x); }',
    '  float depth = max(sz - vViewZ, 0.0);',
    '  vec3 refr = texture2D(uRefr, ruv).rgb;',
    '  float absorb = 1.0 - exp(-depth * uAbsorb);',
    '  vec3 deepLit = mix(uDeep, uShallow, 0.45);',
    '  vec3 under = mix(refr, deepLit, absorb);',
    '  under = mix(under, mix(uShallow, uDeep, 0.45) * 1.1, uMurk * (0.4 + 0.6 * absorb));',
    // reflection through the mirror camera's projective texture
    '  vec2 rc = vRefl.xy / vRefl.w + n.xz * distAmt * 1.4;',
    '  vec3 refl = texture2D(uRefl, clamp(rc, 0.001, 0.999)).rgb;',
    '  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);',
    '  fres = clamp(fres * 0.62, 0.0, 0.62);',   // as through polarised glasses
    '  vec3 c = mix(under, refl, fres);',
    '  vec3 sun = normalize(uSunDir);',
    '  vec3 hv = normalize(sun + v);',
    '  float spec = pow(max(dot(n, hv), 0.0), 320.0) * 2.2 + pow(max(dot(n, hv), 0.0), 40.0) * 0.10;',
    '  c += vec3(1.0, 0.96, 0.88) * spec;',
    // edge foam where the water is very shallow
    '  float foam = (1.0 - smoothstep(0.0, 0.06, depth)) * 0.35 * (0.5 + n1.x * 0.5);',
    '  c = mix(c, vec3(0.9, 0.93, 0.94), foam);',
    '  float fog = smoothstep(uFogNear, uFogFar, dist);',
    '  c = mix(c, uFogColor, fog);',
    '  gl_FragColor = vec4(c, 1.0);',
    '  #include <tonemapping_fragment>',
    '  #include <colorspace_fragment>',
    '}'
  ].join('\n');

  // ---- renderer ------------------------------------------------------------

  function Renderer(canvas, game) {
    EN.renderer3d = this;
    this.canvas = canvas;
    this.game = game;
    this.t = 0;
    this._presetKey = null;
    this._view = 'bank';

    this.renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;   // rendered once per frame in draw()

    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(38, 1, 0.1, 80);
    this.sunDir = new T.Vector3(-3.5, 5.0, 3.2).normalize();
    this._focus = new T.Vector3(4.3, 0.25, 0);
    this.veg = { uTime: { value: 0 } };

    // Every surface texture is baked from noise at start-up (~0.3 s).
    var greyStones = [rgb(150, 144, 132), rgb(122, 118, 108), rgb(168, 158, 140), rgb(104, 110, 100), rgb(140, 126, 104), rgb(96, 92, 84)];
    var dryStones = [rgb(178, 170, 156), rgb(150, 142, 128), rgb(196, 186, 168), rgb(132, 130, 122), rgb(166, 150, 126)];
    this.tex = {
      gravel: bakeGravel(512, 13, 5, greyStones, rgb(48, 46, 40), false),
      shingle: bakeGravel(512, 19, 9, dryStones, rgb(96, 90, 80), true),
      rock: bakeRock(256, 3),
      turf: bakeTurf(256, 4),
      grass: bakeGrassCard(256, 6),
      tree: bakeTreeCard(256, 8),
      waterN: bakeWaterNormals(256, 2)
    };

    this._buildSky();
    this._buildLights();
    this._buildWater();
    this._buildBanks();
    this._buildTackle();
    this._buildAngler();
    this._buildParticles();
    this._buildBeat();          // bed, stones, lies — rebuilt per preset

    this.resize();
  }

  Renderer.prototype.setView = function (name) {
    this._view = name === 'side' ? 'side' : 'bank';
    this._placeCamera();
  };

  Renderer.prototype._placeCamera = function () {
    var focus = this._focus;
    focus.set(4.3, 0.25, 0);
    if (this._view === 'side') {
      this.camera.position.set(5.0, 2.25, 7.6);
      focus.set(4.8, 0.05, 0);
    } else {
      this.camera.position.set(6.1, 2.3, 6.1);
      focus.set(4.3, 0.0, 0);
    }
    this.camera.lookAt(focus);
    if (this.water) this.water.material.uniforms.uCamPos.value.copy(this.camera.position);
  };

  // ---- sky and light -------------------------------------------------------

  Renderer.prototype._buildSky = function () {
    var geo = new T.SphereGeometry(60, 32, 16);
    this.skyMat = new T.ShaderMaterial({
      uniforms: { uSun: { value: this.sunDir.clone() }, uTime: { value: 0 }, uCloud: { value: 0.5 } },
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      side: T.BackSide, depthWrite: false, fog: false
    });
    this.sky = new T.Mesh(geo, this.skyMat);
    this.scene.add(this.sky);
    this.scene.fog = new T.Fog(hex('#cfd8dd'), 14, 46);

    // The sky lights everything: bake it into an environment map once so
    // every PBR surface picks up sky-blue on its upper faces and glints.
    var pmrem = new T.PMREMGenerator(this.renderer);
    var envScene = new T.Scene();
    envScene.add(new T.Mesh(geo, this.skyMat));
    this.envRT = pmrem.fromScene(envScene, 0.02);
    this.scene.environment = this.envRT.texture;
    pmrem.dispose();
  };

  Renderer.prototype._buildLights = function () {
    this.hemi = new T.HemisphereLight(hex('#b9cfe0'), hex('#5a5240'), 0.35);
    this.scene.add(this.hemi);
    this.sun = new T.DirectionalLight(hex('#fff3dc'), 2.6);
    this.sun.position.copy(this.sunDir).multiplyScalar(18);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1536, 1536);
    var sc = this.sun.shadow.camera;
    sc.near = 4; sc.far = 44;
    sc.left = -9; sc.right = 9; sc.top = 8; sc.bottom = -8;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    this.sun.target.position.set(4.3, 0, 0);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
  };

  // ---- water ---------------------------------------------------------------

  Renderer.prototype._buildWater = function () {
    var geo = new T.PlaneGeometry(44, 30, 96, 64);
    geo.rotateX(-Math.PI / 2);
    this.reflRT = new T.WebGLRenderTarget(256, 256);
    this.refrRT = new T.WebGLRenderTarget(256, 256, { depthTexture: new T.DepthTexture(256, 256) });
    this.mirrorCam = new T.PerspectiveCamera();
    this.texMatrix = new T.Matrix4();
    this.clipAbove = new T.Plane(new T.Vector3(0, 1, 0), 0.0);
    this.clipBelow = new T.Plane(new T.Vector3(0, -1, 0), 0.04);
    this.waterMat = new T.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uChop: { value: 1 }, uFlow: { value: 0.8 },
        uDeep: { value: hex('#12292f') }, uShallow: { value: hex('#2c5a63') },
        uSunDir: { value: this.sunDir.clone() }, uCamPos: { value: new T.Vector3() },
        uFogColor: { value: hex('#cfd8dd') }, uFogNear: { value: 14 }, uFogFar: { value: 46 },
        uRefl: { value: this.reflRT.texture }, uRefr: { value: this.refrRT.texture },
        uRefrDepth: { value: this.refrRT.depthTexture }, uNormal: { value: this.tex.waterN },
        uAbsorb: { value: 1.2 }, uMurk: { value: 0 }, uNear: { value: 0.1 }, uFar: { value: 80 },
        uRes: { value: new T.Vector2(1, 1) }, uTexMatrix: { value: this.texMatrix }
      },
      vertexShader: WATER_VERT, fragmentShader: WATER_FRAG
    });
    this.water = new T.Mesh(geo, this.waterMat);
    this.water.position.set(4, 0, -4);
    this.scene.add(this.water);
  };

  // ---- banks ---------------------------------------------------------------

  /** Mirror the view camera in the water plane for the reflection pass. */
  Renderer.prototype._updateMirrorCamera = function () {
    var cam = this.camera, mc = this.mirrorCam, f = this._focus;
    mc.position.set(cam.position.x, -cam.position.y, cam.position.z);
    mc.up.set(0, -1, 0);
    mc.lookAt(f.x, -f.y, f.z);
    mc.fov = cam.fov; mc.aspect = cam.aspect; mc.near = cam.near; mc.far = cam.far;
    mc.updateProjectionMatrix();
    mc.updateMatrixWorld();
    this.texMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.texMatrix.multiply(mc.projectionMatrix).multiply(mc.matrixWorldInverse);
  };

  /** Two crossed vertical quads, normals up so lighting follows the ground. */
  function crossCard(w, h) {
    var g = new T.BufferGeometry();
    var hw = w / 2;
    var pos = [], uv = [], nrm = [], idx = [];
    for (var q = 0; q < 2; q++) {
      var ax = q === 0 ? hw : 0, az = q === 0 ? 0 : hw;
      var base = q * 4;
      pos.push(-ax, 0, -az, ax, 0, az, ax, h, az, -ax, h, -az);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3));
    g.setIndex(idx);
    return g;
  }

  /** Grass tufts sway in the vertex shader; the top of the card moves most. */
  function swayMaterial(map, uniforms) {
    var m = new T.MeshStandardMaterial({ map: map, alphaTest: 0.45, side: T.DoubleSide, roughness: 0.95, metalness: 0 });
    m.onBeforeCompile = function (shader) {
      shader.uniforms.uTime = uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          '{',
          '  vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);',
          '  float sw = sin(uTime * 1.4 + ip.x * 2.3 + ip.z * 1.7) * 0.5 + sin(uTime * 2.9 + ip.x * 5.1) * 0.25;',
          '  transformed.x += sw * uv.y * uv.y * 0.05;',
          '}'
        ].join('\n'));
    };
    return m;
  }

  Renderer.prototype._buildBanks = function () {
    var self = this;
    var tex = this.tex;
    function terrain(w, d, sx, sz, ox, oz, heightFn, colorFn, mat, uvScale) {
      var geo = new T.PlaneGeometry(w, d, sx, sz);
      geo.rotateX(-Math.PI / 2);
      var pos = geo.attributes.position, uv = geo.attributes.uv;
      var col = new Float32Array(pos.count * 3);
      for (var i = 0; i < pos.count; i++) {
        var x = pos.getX(i) + ox, z = pos.getZ(i) + oz;
        var y = heightFn(x, z);
        pos.setY(i, y);
        uv.setXY(i, x * uvScale, z * uvScale);
        var c = colorFn(x, z, y);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new T.BufferAttribute(col, 3));
      geo.computeVertexNormals();
      var mesh = new T.Mesh(geo, mat);
      mesh.position.set(ox, 0, oz);
      mesh.receiveShadow = true;
      return mesh;
    }

    // Far bank: rises out of the water at z ≈ -5.5 into turf and hills.
    function farHeight(x, z) {
      var edge = smooth(-5.0, -8.5, z);
      var hills = noise2(x * 0.08, z * 0.08, 3) * 3.2 + noise2(x * 0.25, z * 0.25, 7) * 0.9;
      return -0.35 + edge * (0.8 + hills) + smooth(-9, -28, z) * 3.5;
    }
    this._farHeight = farHeight;
    var turfMat = new T.MeshStandardMaterial({ map: tex.turf.map, normalMap: tex.turf.normalMap,
      normalScale: new T.Vector2(0.7, 0.7), vertexColors: true, roughness: 0.95, metalness: 0 });
    var far = terrain(60, 24, 60, 24, 4, -17, farHeight, function (x, z, y) {
      var g = 0.85 + noise2(x * 0.6, z * 0.6, 11) * 0.3;
      var c = new T.Color(g, g, g);
      // Wet dark stone right at the waterline, greyer scree on the tops.
      if (y < 0.15) c.lerp(hex('#4a4a44'), smooth(0.15, -0.3, y));
      if (y > 2.6) c.lerp(hex('#8d9296'), smooth(2.6, 5.5, y));
      return c;
    }, turfMat, 0.35);
    this.scene.add(far);

    // Grass over the far bank, thinning up the slope.
    var rnd = seeded(77);
    var grassGeo = crossCard(0.5, 0.42);
    var grassMat = swayMaterial(tex.grass, this.veg);
    var gN = 1000;
    var grass = new T.InstancedMesh(grassGeo, grassMat, gN);
    var m4 = new T.Matrix4(), q = new T.Quaternion(), s3 = new T.Vector3(), p3 = new T.Vector3();
    var placed = 0, tries = 0;
    while (placed < gN && tries < gN * 4) {
      tries++;
      var gx = -10 + rnd() * 30, gz = -5.4 - rnd() * 7.5;
      var gy = farHeight(gx, gz);
      if (gy < -0.05 || gy > 2.9) continue;
      if (rnd() > 1 - smooth(-6.0, -12.5, gz) * 0.6) continue;
      var sc = 0.7 + rnd() * 0.7;
      p3.set(gx, gy - 0.02, gz);
      s3.set(sc, sc * (0.8 + rnd() * 0.5), sc);
      q.setFromEuler(new T.Euler(0, rnd() * Math.PI, 0));
      m4.compose(p3, q, s3);
      grass.setMatrixAt(placed, m4);
      placed++;
    }
    grass.count = placed;
    grass.instanceMatrix.needsUpdate = true;
    grass.receiveShadow = true;
    this.scene.add(grass);

    // A stand of trees along the far bank.
    var treeGeo = crossCard(1, 1);
    var treeMat = new T.MeshStandardMaterial({ map: tex.tree, alphaTest: 0.5, side: T.DoubleSide, roughness: 0.9, metalness: 0 });
    var tN = 18;
    var trees = new T.InstancedMesh(treeGeo, treeMat, tN);
    for (var t = 0; t < tN; t++) {
      var tx = -9 + (t / tN) * 30 + (rnd() - 0.5) * 2.2, tz = -7.8 - rnd() * 5.5;
      var ty = farHeight(tx, tz);
      var th = 3.2 + rnd() * 2.6;
      p3.set(tx, ty - 0.1, tz);
      s3.set(th * (0.85 + rnd() * 0.3), th, th * (0.85 + rnd() * 0.3));
      q.setFromEuler(new T.Euler(0, rnd() * Math.PI, 0));
      m4.compose(p3, q, s3);
      trees.setMatrixAt(t, m4);
    }
    trees.instanceMatrix.needsUpdate = true;
    trees.castShadow = true;
    this.scene.add(trees);

    // Beyond the near shore, a flat of dry shingle continues under the camera.
    var dryMat = new T.MeshStandardMaterial({ map: tex.shingle.map, normalMap: tex.shingle.normalMap,
      roughnessMap: tex.shingle.roughnessMap, normalScale: new T.Vector2(0.9, 0.9), vertexColors: true, roughness: 1, metalness: 0 });
    var near = terrain(60, 14, 30, 7, 4, 15.5, function (x, z) {
      return 1.55 + smooth(8.5, 16, z) * 0.6 + noise2(x * 0.5, z * 0.5, 5) * 0.12;
    }, function (x, z) {
      var g = 0.9 + noise2(x * 1.3, z * 1.3, 13) * 0.25;
      return new T.Color(g, g * 0.98, g * 0.94);
    }, dryMat, 0.5);
    this.scene.add(near);
  };

  // ---- the beat: bed, stones, lies -----------------------------------------
  // Rebuilt whenever the preset changes. The bed is a heightfield straight off
  // river.bedY along x, shaped across the stream so it climbs into both banks,
  // with the cobble colour and the darkening round each boulder baked into the
  // vertices. Caustics and the depth tint are added in the shader.

  Renderer.prototype._buildBeat = function () {
    var river = this.game.river;
    var preset = river.preset;
    var self = this;

    if (this.beat) { this.scene.remove(this.beat); this.beat.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }
    this.beat = new T.Group();

    var rocks = preset.rocks || [];
    var rnd = seeded(preset.key.length * 7919 + 17);

    function bedY(x, z) {
      var base = river.bedY(x);
      // Deepest a little beyond the rig plane, climbing into the near bank fast
      // and the far bank slowly, with a little cobble roughness on top.
      // The near shore is part of the same surface: it shelves up through the
      // waterline into shingle so there is never a seam or a hole at the edge.
      var across = smooth(0.4, 2.6, z) * 0.9;
      var shore = smooth(2.6, 7.5, z) * 1.5 + smooth(6.0, 9.0, z) * 0.4;
      var trough = -0.10 * Math.exp(-((z + 1.2) * (z + 1.2)) / 2.2);
      var rough = (noise2(x * 3.1, z * 3.1, 2) - 0.5) * 0.05 + smooth(0.0, 3.0, z) * (noise2(x * 0.5, z * 0.5, 5) - 0.5) * 0.18;
      return base + across + shore + trough + rough;
    }
    this._bedY = bedY;

    var geo = new T.PlaneGeometry(16, 18, 128, 108);
    geo.rotateX(-Math.PI / 2);
    var pos = geo.attributes.position;
    var col = new Float32Array(pos.count * 3);
    var uvs = geo.attributes.uv;
    // Vertex colours tint the gravel map: algae, shadowed pockets, dry shingle.
    var algae = hex('#8fb46a'), dark = hex('#5a5852'), shingle = hex('#c9bfae');
    for (var i = 0; i < pos.count; i++) {
      var x = pos.getX(i) + 4.0, z = pos.getZ(i) + 0.5;
      var y = bedY(x, z);
      pos.setY(i, y);
      uvs.setXY(i, x * 0.55, z * 0.55);
      var g = noise2(x * 2.2, z * 2.2, 21);
      var tone = 0.78 + g * 0.42;
      var c = new T.Color(tone, tone, tone);
      if (noise2(x * 1.1, z * 1.1, 33) > 0.62) c.lerp(algae, 0.5);
      // Dry shingle above the waterline, a damp dark band right at it.
      if (y > -0.2) c.lerp(dark, smooth(-0.2, -0.02, y) * (1 - smooth(-0.02, 0.12, y)) * 0.6);
      if (y > -0.02) c.lerp(shingle, smooth(-0.02, 0.15, y));
      // Shadowed pockets behind boulders.
      for (var r = 0; r < rocks.length; r++) {
        var d = Math.hypot(x - rocks[r].x - rocks[r].r * 0.5, z);
        c.lerp(dark, clamp(1 - d / (rocks[r].r * 2.2), 0, 0.55));
      }
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    geo.computeVertexNormals();

    var tx = this.tex;
    var bedMat = new T.MeshStandardMaterial({ map: tx.gravel.map, normalMap: tx.gravel.normalMap,
      roughnessMap: tx.gravel.roughnessMap, normalScale: new T.Vector2(1, 1), vertexColors: true, roughness: 1, metalness: 0 });
    var uniforms = this.bedUniforms = {
      uTime: { value: 0 },
      uWaterDeep: { value: hex(preset.water ? preset.water.deep : '#12292f') },
      uMurk: { value: 0.12 + (preset.murk || 0) * 0.5 },
      uClarity: { value: 1 - Math.min(1, (preset.murk || 0) * 1.1) },
      uMaxDepth: { value: (river.maxDepth || 1) + 0.3 }
    };
    bedMat.onBeforeCompile = function (shader) {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uWaterDeep = uniforms.uWaterDeep;
      shader.uniforms.uMurk = uniforms.uMurk;
      shader.uniforms.uClarity = uniforms.uClarity;
      shader.uniforms.uMaxDepth = uniforms.uMaxDepth;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBedWorld;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvBedWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', [
          '#include <common>',
          'varying vec3 vBedWorld;',
          'uniform float uTime; uniform vec3 uWaterDeep; uniform float uMurk; uniform float uClarity; uniform float uMaxDepth;'
        ].join('\n'))
        .replace('#include <color_fragment>', [
          '#include <color_fragment>',
          '{',
          '  float under = 1.0 - smoothstep(-0.02, 0.03, vBedWorld.y);',
          '  float depth = clamp(-vBedWorld.y / uMaxDepth, 0.0, 1.0);',
          '  float c1 = sin(vBedWorld.x * 9.0 + uTime * 1.6) * sin(vBedWorld.z * 7.0 - uTime * 1.1);',
          '  float c2 = sin(vBedWorld.x * 17.0 - uTime * 2.3 + vBedWorld.z * 3.0) * sin(vBedWorld.z * 13.0 + uTime * 1.7);',
          '  float caus = pow(clamp(c1 * 0.5 + 0.5, 0.0, 1.0), 5.0) * 0.7 + pow(clamp(c2 * 0.5 + 0.5, 0.0, 1.0), 6.0) * 0.5;',
          '  diffuseColor.rgb += vec3(0.75, 0.92, 0.95) * caus * uClarity * under * (1.0 - depth * 0.6) * 0.42;',
          '  diffuseColor.rgb = mix(diffuseColor.rgb, uWaterDeep, under * depth * uMurk);',
          '}'
        ].join('\n'));
    };
    var bed = new T.Mesh(geo, bedMat);
    bed.position.set(4.0, 0, 0.5);
    bed.receiveShadow = true;
    this.beat.add(bed);

    // Boulders from the preset, on the rig plane where the physics has them.
    var rockMat = new T.MeshStandardMaterial({ map: tx.rock.map, normalMap: tx.rock.normalMap,
      normalScale: new T.Vector2(1.2, 1.2), roughness: 0.78, metalness: 0.0 });
    var cobbleMat = new T.MeshStandardMaterial({ map: tx.rock.map, normalMap: tx.rock.normalMap,
      normalScale: new T.Vector2(0.9, 0.9), roughness: 0.7, metalness: 0.0 });
    // Each boulder is a sphere knocked about by noise so no two are alike.
    function boulderGeo(seedK) {
      var bg = new T.SphereGeometry(1, 40, 26);
      var bp = bg.attributes.position;
      for (var vi = 0; vi < bp.count; vi++) {
        var vx = bp.getX(vi), vy = bp.getY(vi), vz = bp.getZ(vi);
        var d = 0.82 + noise2(vx * 1.6 + seedK, vy * 1.6, 41) * 0.28 + noise2(vx * 4 + seedK, vz * 4, 43) * 0.08;
        if (vy < -0.2) d *= 1 + (-0.2 - vy) * 0.25;       // flatter, wider base
        bp.setXYZ(vi, vx * d, vy * d, vz * d);
      }
      bg.computeVertexNormals();
      return bg;
    }
    for (var k = 0; k < rocks.length; k++) {
      var rk = rocks[k];
      var m = new T.Mesh(boulderGeo(k * 3.7), rockMat);
      var cy = river.bedY(rk.x) + rk.r * 0.55;
      // The physics only knows the rock's x; keep its bulk just to the far
      // side of the drift lane so the fish holding behind it stay in view.
      m.position.set(rk.x, cy, -(rk.r * 0.75 + 0.12));
      m.scale.set(rk.r, rk.r * 0.82, rk.r * 1.15);
      m.rotation.y = rnd() * Math.PI;
      m.castShadow = true; m.receiveShadow = true;
      this.beat.add(m);
    }

    // Cobbles scattered across the bed, instanced.
    var n = 220;
    var cobble = new T.InstancedMesh(new T.SphereGeometry(1, 8, 6),
      cobbleMat, n);
    var mtx = new T.Matrix4(), q = new T.Quaternion(), sc = new T.Vector3(), pv = new T.Vector3();
    var tint = new T.Color();
    for (var j = 0; j < n; j++) {
      var cx = 0.2 + rnd() * 9.0, cz = -5.0 + rnd() * 6.6;
      var by = bedY(cx, cz);
      if (by > 0.05) { cx = 3 + rnd() * 3; cz = -1 + rnd() * 1.6; by = bedY(cx, cz); }
      var s = 0.035 + rnd() * rnd() * 0.13;
      pv.set(cx, by + s * 0.35, cz);
      sc.set(s * (0.8 + rnd() * 0.5), s * 0.65, s * (0.8 + rnd() * 0.5));
      q.setFromEuler(new T.Euler(0, rnd() * Math.PI, 0));
      mtx.compose(pv, q, sc);
      cobble.setMatrixAt(j, mtx);
      tint.set(rnd() < 0.2 ? '#4f5a3a' : '#8a8170').lerp(hex('#3d382c'), rnd() * 0.5);
      cobble.setColorAt(j, tint);
    }
    // A few dry stones up the shingle so the shore is not a bare dune.
    var dryN = 110;
    var dry = new T.InstancedMesh(new T.SphereGeometry(1, 8, 6),
      cobbleMat, dryN);
    for (var jd = 0; jd < dryN; jd++) {
      var dx = -1 + rnd() * 11.5, dz = 2.9 + rnd() * 4.2;
      var dy = bedY(dx, dz);
      var ds = 0.03 + rnd() * rnd() * 0.16;
      pv.set(dx, dy + ds * 0.3, dz);
      sc.set(ds * (0.8 + rnd() * 0.6), ds * 0.6, ds * (0.8 + rnd() * 0.6));
      q.setFromEuler(new T.Euler(0, rnd() * Math.PI, 0));
      mtx.compose(pv, q, sc);
      dry.setMatrixAt(jd, mtx);
      tint.set('#e8e2d6').lerp(hex('#a8a096'), rnd() * 0.6);
      dry.setColorAt(jd, tint);
    }
    dry.instanceMatrix.needsUpdate = true;
    if (dry.instanceColor) dry.instanceColor.needsUpdate = true;
    dry.castShadow = true; dry.receiveShadow = true;
    this.beat.add(dry);

    // Tufts along the top of the shingle.
    var tuftN = 140;
    var tufts = new T.InstancedMesh(crossCard(0.5, 0.42), swayMaterial(this.tex.grass, this.veg), tuftN);
    for (var jt = 0; jt < tuftN; jt++) {
      var tx2 = -1 + rnd() * 11.5, tz2 = 4.2 + rnd() * 1.1;
      var ts = 0.3 + rnd() * 0.4;
      pv.set(tx2, bedY(tx2, tz2) - 0.02, tz2);
      sc.set(ts, ts * (0.8 + rnd() * 0.5), ts);
      q.setFromEuler(new T.Euler(0, rnd() * Math.PI, 0));
      mtx.compose(pv, q, sc);
      tufts.setMatrixAt(jt, mtx);
    }
    tufts.instanceMatrix.needsUpdate = true;
    tufts.receiveShadow = true;
    this.beat.add(tufts);

    cobble.instanceMatrix.needsUpdate = true;
    if (cobble.instanceColor) cobble.instanceColor.needsUpdate = true;
    cobble.receiveShadow = true;
    this.beat.add(cobble);

    // Lie markers, only shown in learning mode.
    this.lieMarks = [];
    var lies = preset.lies || [];
    var ringGeo = new T.RingGeometry(0.30, 0.34, 40);
    ringGeo.rotateX(-Math.PI / 2);
    var ringMat = new T.MeshBasicMaterial({ color: hex('#ffd678'), transparent: true, opacity: 0.45, depthWrite: false });
    for (var L = 0; L < lies.length; L++) {
      var ring = new T.Mesh(ringGeo, ringMat);
      ring.position.set(lies[L].x, river.bedY(lies[L].x) + 0.03, 0);
      ring.scale.setScalar(1 + lies[L].quality * 0.4);
      ring.visible = false;
      this.beat.add(ring);
      this.lieMarks.push(ring);
    }

    this.scene.add(this.beat);
    this._presetKey = preset.key;

    // Water and sky take on the beat too.
    var w = preset.water || { surface: '#2c5a63', mid: '#1d4048', deep: '#12292f' };
    var u = this.waterMat.uniforms;
    u.uDeep.value.set(w.deep);
    u.uShallow.value.set(w.surface);
    u.uChop.value = 0.55 + (preset.turbulence || 0.1) * 3.2 + (preset.flow || 0.8) * 0.35;
    u.uFlow.value = preset.flow || 0.8;
    u.uAbsorb.value = 0.9 + (preset.murk || 0) * 5.0;
    u.uMurk.value = (preset.murk || 0) * 0.9;
    if (preset.blind) { u.uAbsorb.value = Math.max(u.uAbsorb.value, 4.5); u.uMurk.value = Math.max(u.uMurk.value, 0.75); }
  };

  // ---- dynamic tubes -------------------------------------------------------
  // A tube whose topology is fixed and whose vertices are rewritten every frame
  // from a fresh list of points. Used for the rod, the leader and the fish.

  function DynTube(points, radial, radiusFn, material) {
    this.n = points;
    this.radial = radial;
    this.radiusFn = radiusFn;
    var count = points * radial;
    this.geo = new T.BufferGeometry();
    this.pos = new Float32Array(count * 3);
    this.nrm = new Float32Array(count * 3);
    this.uv = new Float32Array(count * 2);
    var idx = [];
    for (var i = 0; i < points - 1; i++) {
      for (var j = 0; j < radial; j++) {
        var a = i * radial + j, b = i * radial + (j + 1) % radial;
        var c = (i + 1) * radial + j, d = (i + 1) * radial + (j + 1) % radial;
        idx.push(a, b, c, b, d, c);   // counter-clockwise from outside
      }
    }
    for (var k = 0; k < count; k++) {
      this.uv[k * 2] = Math.floor(k / radial) / (points - 1);
      this.uv[k * 2 + 1] = (k % radial) / radial;
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new T.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('normal', new T.BufferAttribute(this.nrm, 3));
    this.geo.setAttribute('uv', new T.BufferAttribute(this.uv, 2));
    this.mesh = new T.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this._up = new T.Vector3(0, 1, 0);
    this._t = new T.Vector3(); this._nn = new T.Vector3(); this._bb = new T.Vector3();
  }

  /**
   * pts: array of {x,y,z}. sideways: optional function(s) -> lateral offset
   * applied along the binormal, for a swimming fish. widthFn: optional
   * function(s) -> half-width multiplier along the binormal (ellipse sections).
   */
  DynTube.prototype.set = function (pts, widthFn) {
    var n = this.n, R = this.radial;
    var t = this._t, nn = this._nn, bb = this._bb, up = this._up;
    for (var i = 0; i < n; i++) {
      var p = pts[i];
      var pa = pts[Math.max(0, i - 1)], pb = pts[Math.min(n - 1, i + 1)];
      t.set(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
      if (t.lengthSq() < 1e-10) t.set(1, 0, 0);
      t.normalize();
      // Frame: prefer world-up as the reference so the tube does not twist.
      nn.copy(up).sub(t.clone().multiplyScalar(up.dot(t)));
      if (nn.lengthSq() < 1e-6) nn.set(0, 0, 1);
      nn.normalize();
      bb.crossVectors(t, nn);
      var s = i / (n - 1);
      var r = this.radiusFn(s);
      var wmul = widthFn ? widthFn(s) : 1;
      for (var j = 0; j < R; j++) {
        var a = (j / R) * Math.PI * 2;
        var ca = Math.cos(a), sa = Math.sin(a);
        var ox = nn.x * ca * r + bb.x * sa * r * wmul;
        var oy = nn.y * ca * r + bb.y * sa * r * wmul;
        var oz = nn.z * ca * r + bb.z * sa * r * wmul;
        var k = (i * R + j) * 3;
        this.pos[k] = p.x + ox; this.pos[k + 1] = p.y + oy; this.pos[k + 2] = p.z + oz;
        var nl = Math.hypot(ox, oy, oz) || 1;
        this.nrm[k] = ox / nl; this.nrm[k + 1] = oy / nl; this.nrm[k + 2] = oz / nl;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
  };

  // ---- tackle: rod, leader, flies ------------------------------------------

  Renderer.prototype._buildTackle = function () {
    var self = this;
    this.tackle = new T.Group();

    // Rod: tapered from a fat butt to a fine tip.
    this.rod = new DynTube(18, 7, function (s) { return 0.011 * (1 - s) + 0.0018; },
      new T.MeshStandardMaterial({ color: hex('#2a2f34'), roughness: 0.45, metalness: 0.25 }));
    this.rod.mesh.castShadow = true;
    this.tackle.add(this.rod.mesh);

    this.cork = new T.Mesh(new T.CylinderGeometry(0.016, 0.019, 0.26, 10),
      new T.MeshStandardMaterial({ color: hex('#b79a68'), roughness: 0.9 }));
    this.tackle.add(this.cork);

    var reelMat = new T.MeshStandardMaterial({ color: hex('#5a6168'), roughness: 0.35, metalness: 0.7 });
    this.reel = new T.Mesh(new T.CylinderGeometry(0.085, 0.085, 0.05, 24), reelMat);
    this.reel.rotation.x = Math.PI / 2;
    this.tackle.add(this.reel);

    // Leader in two pieces so the sighter can glow unlit.
    var rig = this.game.rig;
    var n = rig.config.nodes;
    this.leaderN = n;
    this.leader = new DynTube(n, 5, function (s) { return s < 0.5 ? 0.0032 : 0.0018; },
      new T.MeshStandardMaterial({ color: hex('#d8d2c2'), roughness: 0.4, metalness: 0.05 }));
    this.tackle.add(this.leader.mesh);

    var sn = rig.sighterTo - rig.sighterFrom + 1;
    this.sighterN = sn;
    var sighterColors = new Float32Array(sn * 5 * 3);
    this.sighter = new DynTube(sn, 5, function () { return 0.0055; },
      new T.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
    var bands = [hex('#ff7a1a'), hex('#ffe14d'), hex('#ff7a1a'), hex('#b6ff5a')];
    for (var i = 0; i < sn; i++) {
      var band = bands[Math.floor((i / sn) * bands.length) % bands.length];
      for (var j = 0; j < 5; j++) {
        var k = (i * 5 + j) * 3;
        sighterColors[k] = band.r * 1.4; sighterColors[k + 1] = band.g * 1.4; sighterColors[k + 2] = band.b * 1.4;
      }
    }
    this.sighter.geo.setAttribute('color', new T.BufferAttribute(sighterColors, 3));
    this.tackle.add(this.sighter.mesh);

    this.tag = new DynTube(2, 4, function () { return 0.0015; },
      new T.MeshStandardMaterial({ color: hex('#d8d2c2'), roughness: 0.4 }));
    this.tackle.add(this.tag.mesh);

    function fly(beadR, bodyColor) {
      var g = new T.Group();
      var bead = new T.Mesh(new T.SphereGeometry(beadR, 12, 10),
        new T.MeshStandardMaterial({ color: hex('#d9b24a'), roughness: 0.25, metalness: 0.9 }));
      var body = new T.Mesh(new T.SphereGeometry(beadR * 0.85, 10, 8),
        new T.MeshStandardMaterial({ color: hex(bodyColor), roughness: 0.8 }));
      body.scale.set(1.8, 0.8, 0.8);
      body.position.x = beadR * 1.6;
      g.add(bead); g.add(body);
      return g;
    }
    this.pointFly = fly(0.011, '#5b4a2e');
    this.dropperFly = fly(0.0085, '#7c8f6e');
    this.tackle.add(this.pointFly);
    this.tackle.add(this.dropperFly);

    this.scene.add(this.tackle);
  };

  // ---- fish ----------------------------------------------------------------
  // The same half-height profile as the 2D fish, swept into a body of elliptic
  // rings. The spine wave is lateral now, which is how a fish actually swims.

  var BODY = [
    [0.00, 0.020], [0.05, 0.075], [0.12, 0.118], [0.22, 0.150], [0.32, 0.161],
    [0.45, 0.152], [0.58, 0.130], [0.70, 0.103], [0.82, 0.072], [0.91, 0.048], [1.00, 0.030]
  ];
  function halfHeight(s) {
    for (var i = 1; i < BODY.length; i++) {
      if (s <= BODY[i][0]) {
        var a = BODY[i - 1], b = BODY[i];
        return a[1] + (b[1] - a[1]) * ((s - a[0]) / (b[0] - a[0]));
      }
    }
    return BODY[BODY.length - 1][1];
  }

  /** A skin texture with countershading and spots, baked once per species. */
  function fishTexture(species) {
    var w = 256, h = 128;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    var grad = g.createLinearGradient(0, 0, 0, h);
    // v runs round the body: 0 = top, 0.5 = belly, 1 = top again.
    grad.addColorStop(0.00, species.back);
    grad.addColorStop(0.22, species.body);
    grad.addColorStop(0.40, species.belly);
    grad.addColorStop(0.60, species.belly);
    grad.addColorStop(0.78, species.body);
    grad.addColorStop(1.00, species.back);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    var rnd = seeded(species.key === 'brown' ? 41 : 97);
    for (var i = 0; i < 90; i++) {
      var u = 0.08 + rnd() * 0.85, band = rnd();
      // Spots live on the back and flanks, not the belly.
      var v = band < 0.5 ? band * 0.30 : 0.70 + (band - 0.5) * 0.60;
      var r = 1.6 + rnd() * 2.6;
      var red = species.redSpots && rnd() < 0.22;
      g.fillStyle = red ? species.redSpot : species.spot;
      g.beginPath();
      g.arc(u * w, v * h, r, 0, Math.PI * 2);
      g.fill();
    }
    var tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    tex.wrapS = T.ClampToEdgeWrapping; tex.wrapT = T.RepeatWrapping;
    return tex;
  }

  function FishMesh(species, texCache) {
    this.group = new T.Group();
    if (!texCache[species.key]) texCache[species.key] = fishTexture(species);
    var mat = new T.MeshStandardMaterial({ map: texCache[species.key], roughness: 0.45, metalness: 0.1,
      emissive: hex(species.body), emissiveIntensity: 0.16 });
    var self = this;
    this.L = 0.4;
    this.body = new DynTube(22, 12, function (s) { return halfHeight(s) * self.L; }, mat);
    this.body.mesh.castShadow = true;
    this.group.add(this.body.mesh);

    var finMat = new T.MeshStandardMaterial({ color: hex(species.fin || '#8a6e3e'), roughness: 0.7,
      side: T.DoubleSide, transparent: true, opacity: 0.9 });
    // Tail: a fan in the tube's frame at s = 1.
    this.tail = new T.Mesh(new T.PlaneGeometry(0.22, 0.30), finMat);
    this.group.add(this.tail);
    this.dorsal = new T.Mesh(new T.PlaneGeometry(0.18, 0.13), finMat);
    this.group.add(this.dorsal);
    this.pecL = new T.Mesh(new T.PlaneGeometry(0.11, 0.06), finMat);
    this.pecR = this.pecL.clone();
    this.group.add(this.pecL); this.group.add(this.pecR);

    var eyeMat = new T.MeshStandardMaterial({ color: hex('#0b0b0b'), roughness: 0.2 });
    this.eyeL = new T.Mesh(new T.SphereGeometry(0.014, 8, 6), eyeMat);
    this.eyeR = this.eyeL.clone();
    this.group.add(this.eyeL); this.group.add(this.eyeR);

    this.pts = [];
    for (var i = 0; i < 22; i++) this.pts.push({ x: 0, y: 0, z: 0 });
  }

  /** Lay the body out along local +x, waving sideways, and place the fins. */
  FishMesh.prototype.pose = function (L, phase, amp) {
    var n = this.pts.length;
    for (var i = 0; i < n; i++) {
      var s = i / (n - 1);
      var lateral = amp * Math.sin(s * 5.2 - phase) * (0.12 + s * 0.88) * L;
      this.pts[i].x = s * L; this.pts[i].y = 0; this.pts[i].z = lateral;
    }
    this.L = L;                               // the radius function scales the profile by this
    this.body.set(this.pts, function () { return 0.58; });

    var tailZ = amp * Math.sin(5.2 - phase) * L;
    this.tail.position.set(L * 1.08, 0, tailZ);
    this.tail.rotation.set(0, Math.PI / 2 + Math.sin(phase) * 0.5 * amp * 8, 0);
    this.tail.scale.setScalar(L / 0.4);

    this.dorsal.position.set(L * 0.42, halfHeight(0.42) * L * 0.95, amp * Math.sin(0.42 * 5.2 - phase) * 0.5 * L);
    this.dorsal.rotation.set(0, 0, -0.35);
    this.dorsal.scale.setScalar(L / 0.4);

    var pz = 0.55 * halfHeight(0.22) * L;
    this.pecL.position.set(L * 0.24, -halfHeight(0.22) * L * 0.25, pz);
    this.pecR.position.set(L * 0.24, -halfHeight(0.22) * L * 0.25, -pz);
    this.pecL.rotation.set(0.5, 0.6, 0); this.pecR.rotation.set(-0.5, -0.6, 0);
    this.pecL.scale.setScalar(L / 0.4); this.pecR.scale.setScalar(L / 0.4);

    var ez = 0.58 * halfHeight(0.07) * L * 0.98;
    this.eyeL.position.set(L * 0.07, halfHeight(0.07) * L * 0.25, ez);
    this.eyeR.position.set(L * 0.07, halfHeight(0.07) * L * 0.25, -ez);
    this.eyeL.scale.setScalar(L / 0.4); this.eyeR.scale.setScalar(L / 0.4);
  };

  // ---- the angler and the net ----------------------------------------------

  Renderer.prototype._buildAngler = function () {
    var g = this.game;
    var grp = this.angler = new T.Group();
    var dark = new T.MeshStandardMaterial({ color: hex('#3d6270'), roughness: 0.85 });
    var wader = new T.MeshStandardMaterial({ color: hex('#33403f'), roughness: 0.6 });
    var skin = new T.MeshStandardMaterial({ color: hex('#b8896a'), roughness: 0.7 });

    function capsule(r, len, mat) {
      var m = new T.Mesh(new T.CapsuleGeometry(r, len, 4, 10), mat);
      m.castShadow = true;
      return m;
    }
    var footY = g.river.bedY(g.grip.x) + 0.02;
    var hipY = 0.42;
    this.legL = capsule(0.075, hipY - footY - 0.1, wader);
    this.legR = capsule(0.075, hipY - footY - 0.1, wader);
    this.legL.position.set(g.grip.x + 0.28, (footY + hipY) / 2, 0.42);
    this.legR.position.set(g.grip.x + 0.42, (footY + hipY) / 2, 0.20);
    grp.add(this.legL); grp.add(this.legR);

    this.torso = capsule(0.14, 0.60, dark);
    this.torso.position.set(g.grip.x + 0.34, 0.95, 0.31);
    this.torso.rotation.z = -0.08;
    grp.add(this.torso);

    this.head = new T.Mesh(new T.SphereGeometry(0.095, 14, 12), skin);
    this.head.position.set(g.grip.x + 0.33, 1.47, 0.31);
    this.head.castShadow = true;
    grp.add(this.head);
    this.cap = new T.Mesh(new T.CylinderGeometry(0.105, 0.105, 0.06, 14), dark);
    this.cap.position.set(g.grip.x + 0.33, 1.53, 0.31);
    grp.add(this.cap);
    this.peak = new T.Mesh(new T.BoxGeometry(0.16, 0.012, 0.11), dark);
    this.peak.position.set(g.grip.x + 0.21, 1.505, 0.31);
    grp.add(this.peak);

    this.armRod = new DynTube(3, 6, function (s) { return 0.038 - s * 0.008; }, dark);
    this.armNet = new DynTube(2, 6, function () { return 0.032; }, dark);
    grp.add(this.armRod.mesh); grp.add(this.armNet.mesh);

    // Net: hoop, bag, handle. Slung on the back until it is needed.
    this.net = new T.Group();
    var hoop = new T.Mesh(new T.TorusGeometry(0.30, 0.012, 8, 32),
      new T.MeshStandardMaterial({ color: hex('#26343c'), roughness: 0.6, metalness: 0.3 }));
    hoop.rotation.x = Math.PI / 2;
    this.net.add(hoop);
    var bagGeo = new T.CylinderGeometry(0.30, 0.10, 0.36, 16, 3, true);
    bagGeo.translate(0, -0.18, 0);
    this.bag = new T.Mesh(bagGeo, new T.MeshStandardMaterial({ color: hex('#9fb2b8'), roughness: 0.8,
      transparent: true, opacity: 0.28, side: T.DoubleSide, wireframe: true }));
    this.net.add(this.bag);
    var handle = new T.Mesh(new T.CylinderGeometry(0.012, 0.012, 0.42, 8),
      new T.MeshStandardMaterial({ color: hex('#7a5f38'), roughness: 0.8 }));
    handle.rotation.z = Math.PI / 2;
    handle.position.x = 0.50;
    this.net.add(handle);
    grp.add(this.net);

    this.scene.add(grp);
  };

  // ---- particles: bubbles, spray, rings ------------------------------------

  Renderer.prototype._buildParticles = function () {
    var n = 260;
    this.bubbleN = n;
    var pos = new Float32Array(n * 3);
    this.bubbleGeo = new T.BufferGeometry();
    this.bubbleGeo.setAttribute('position', new T.BufferAttribute(pos, 3));
    this.bubbleData = [];
    for (var i = 0; i < n; i++) this.bubbleData.push({ x: 0, y: -9, z: 0, rise: 0.2 });
    this.bubbles = new T.Points(this.bubbleGeo, new T.PointsMaterial({
      color: hex('#d6f0f4'), size: 0.018, transparent: true, opacity: 0.55, depthWrite: false, sizeAttenuation: true
    }));
    this.bubbles.frustumCulled = false;
    this.scene.add(this.bubbles);

    var sn = 120;
    this.sprayN = sn;
    this.sprayGeo = new T.BufferGeometry();
    this.sprayGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(sn * 3), 3));
    this.sprayData = [];
    for (var j = 0; j < sn; j++) this.sprayData.push({ x: 0, y: -9, z: 0, vx: 0, vy: 0, vz: 0, life: 0 });
    this.spray = new T.Points(this.sprayGeo, new T.PointsMaterial({
      color: hex('#e6f6fa'), size: 0.03, transparent: true, opacity: 0.85, depthWrite: false
    }));
    this.spray.frustumCulled = false;
    this.scene.add(this.spray);

    this.rings = [];
    this.ringGeo = new T.RingGeometry(0.92, 1.0, 40);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.ringMat = new T.MeshBasicMaterial({ color: hex('#e0f4f8'), transparent: true, opacity: 0.5, depthWrite: false });
    this._wasWet = false;
  };

  Renderer.prototype._ring = function (x, r0, speed, life) {
    var m = new T.Mesh(this.ringGeo, this.ringMat.clone());
    m.position.set(x, 0.004, 0);
    m.renderOrder = 11;
    this.scene.add(m);
    this.rings.push({ mesh: m, r: r0, speed: speed, life: life, max: life });
  };

  Renderer.prototype._spray = function (x, y, count, vx) {
    var used = 0;
    for (var i = 0; i < this.sprayN && used < count; i++) {
      var d = this.sprayData[i];
      if (d.life > 0) continue;
      var a = -Math.PI * (0.15 + Math.random() * 0.7);
      var sp = 0.9 + Math.random() * 2.4;
      d.x = x; d.y = Math.max(-0.02, y); d.z = (Math.random() - 0.5) * 0.3;
      d.vx = Math.cos(a) * sp * (Math.random() < 0.5 ? -1 : 1) * 0.6 + vx * 0.35;
      d.vy = -Math.sin(a) * sp;
      d.vz = (Math.random() - 0.5) * 1.4;
      d.life = 0.5 + Math.random() * 0.6;
      used++;
    }
  };

  Renderer.prototype._updateParticles = function (dt) {
    var river = this.game.river;
    var want = Math.round(20 + (river.preset.turbulence || 0.1) * 200);
    var pos = this.bubbleGeo.attributes.position.array;
    for (var i = 0; i < this.bubbleN; i++) {
      var b = this.bubbleData[i];
      if (i >= want) { pos[i * 3 + 1] = -9; continue; }
      if (b.y > -0.01 || b.y < -8 || b.x > W.xMax + 0.5) {
        b.x = W.xMin - 0.3 + Math.random() * (W.xMax - W.xMin) * 0.8;
        b.z = -2.4 + Math.random() * 2.9;
        b.y = river.bedY(b.x) + Math.random() * 0.25;
        b.rise = 0.12 + Math.random() * 0.28;
      }
      b.x += river.speedAt(b.x, b.y) * dt;
      b.y += b.rise * dt;
      pos[i * 3] = b.x; pos[i * 3 + 1] = b.y; pos[i * 3 + 2] = b.z;
    }
    this.bubbleGeo.attributes.position.needsUpdate = true;

    var sp = this.sprayGeo.attributes.position.array;
    for (var j = 0; j < this.sprayN; j++) {
      var d = this.sprayData[j];
      if (d.life <= 0) { sp[j * 3 + 1] = -9; continue; }
      d.vy -= 9.81 * dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      d.life -= dt;
      if (d.y < -0.02) d.life = 0;
      sp[j * 3] = d.x; sp[j * 3 + 1] = d.y; sp[j * 3 + 2] = d.z;
    }
    this.sprayGeo.attributes.position.needsUpdate = true;

    for (var k = this.rings.length - 1; k >= 0; k--) {
      var r = this.rings[k];
      r.r += r.speed * dt;
      r.life -= dt;
      r.mesh.position.x += river.speedAt(r.mesh.position.x, -0.02) * dt;
      r.mesh.scale.set(r.r, 1, r.r * 0.55);
      r.mesh.material.opacity = 0.5 * Math.max(0, r.life / r.max);
      if (r.life <= 0) { this.scene.remove(r.mesh); r.mesh.material.dispose(); this.rings.splice(k, 1); }
    }

    // Splashes from the tackle and from fish going out and coming back.
    var p = this.game.rig.point();
    var wet = p.y < 0;
    if (wet && !this._wasWet) this._ring(p.x, 0.02, 0.5 + Math.min(1.5, Math.abs(p.vy)), 1.0);
    this._wasWet = wet;
    var fishes = this.game.school.fish;
    for (var f = 0; f < fishes.length; f++) {
      var fi = fishes[f];
      if (fi.state !== 'hooked') { fi._wasAir3 = false; continue; }
      if (fi.airborne && !fi._wasAir3) { this._ring(fi.x, 0.05, 1.9, 1.3); this._spray(fi.x, fi.y, 24, fi.vx); }
      if (!fi.airborne && fi._wasAir3) { this._ring(fi.x, 0.06, 2.4, 1.5); this._ring(fi.x, 0.02, 1.3, 1.2); this._spray(fi.x, fi.y, 32, fi.vx); }
      fi._wasAir3 = fi.airborne;
    }
  };

  // ---- per-frame sync ------------------------------------------------------

  Renderer.prototype.update = function (dt) {
    this.t += dt;
    if (this._presetKey !== this.game.river.preset.key) this._buildBeat();
    this.waterMat.uniforms.uTime.value = this.t;
    this.skyMat.uniforms.uTime.value = this.t;
    this.veg.uTime.value = this.t;
    this.bedUniforms.uTime.value = this.t;
    this._updateParticles(dt);
  };

  Renderer.prototype._syncTackle = function () {
    var g = this.game;
    var rig = g.rig;
    var hud = g.hudState();

    // The physics keeps the hand at one fixed point and moves only the tip,
    // which from the side reads as the rod pivoting about its butt. A real
    // stroke is mostly the hand travelling back and forth with the rod angle
    // changing far less, so draw the hand a good fraction of the way along
    // the tip's excursion from its resting fishing position, within reach.
    var tx = g.tip.x, ty = g.tip.y;
    var hand = this._hand(tx, ty);
    var gx = hand.x, gy = hand.y;
    var bend = Math.min(1, hud.tension * 0.9 + rig.contact * 0.12) * 0.22;
    var mx = (gx + tx) / 2, my = (gy + ty) / 2;
    var nx = -(ty - gy), ny = (tx - gx);
    var nl = Math.hypot(nx, ny) || 1;
    var cx = mx + nx / nl * bend, cy = my + ny / nl * bend;
    var pts = [];
    for (var i = 0; i < 18; i++) {
      var s = i / 17, u = 1 - s;
      pts.push({ x: u * u * gx + 2 * u * s * cx + s * s * tx,
                 y: u * u * gy + 2 * u * s * cy + s * s * ty, z: 0 });
    }
    this.rod.set(pts);
    var ux = tx - gx, uy = ty - gy, ul = Math.hypot(ux, uy) || 1;
    ux /= ul; uy /= ul;
    this.cork.position.set(gx + ux * 0.02, gy + uy * 0.02, 0);
    this.cork.rotation.z = Math.atan2(uy, ux) - Math.PI / 2;
    this.reel.position.set(gx - ux * 0.20 - uy * 0.0, gy - uy * 0.20 - 0.06, 0);

    // Leader and sighter straight off the rig nodes.
    var nodes = rig.nodes, n = this.leaderN;
    var lp = [];
    for (var k = 0; k < n; k++) lp.push({ x: nodes[k].x, y: nodes[k].y, z: 0 });
    this.leader.set(lp);
    var sp = [];
    for (var q = rig.sighterFrom; q <= rig.sighterTo; q++) sp.push({ x: nodes[q].x, y: nodes[q].y, z: 0 });
    this.sighter.set(sp);

    var p = rig.point();
    this.pointFly.position.set(p.x, p.y, 0);
    this.pointFly.rotation.z = Math.atan2(p.vy || 0, (p.vx || 0.01)) + Math.PI;
    var d = rig.dropper();
    if (d) {
      var host = nodes[rig.dropperHost];
      this.tag.set([{ x: host.x, y: host.y, z: 0 }, { x: d.x, y: d.y, z: 0 }]);
      this.dropperFly.position.set(d.x, d.y, 0);
      this.dropperFly.visible = true; this.tag.mesh.visible = true;
    } else { this.dropperFly.visible = false; this.tag.mesh.visible = false; }
  };

  /**
   * Where the rod hand is drawn for a given tip position: the game's grip
   * point plus a share of the tip's excursion, eased off so the arm never
   * leaves the shoulder. Cached per frame for the arm and torso.
   */
  Renderer.prototype._hand = function (tx, ty) {
    var g = this.game;
    var G = g.grip;
    // Resting fishing position: rod up and out over the water at a lean.
    var rx = G.x - 2.3, ry = 2.0;
    var hx = G.x + (tx - rx) * 0.5;
    var hy = G.y + (ty - ry) * 0.30;
    var dx = hx - G.x, dy = hy - G.y, d = Math.hypot(dx, dy);
    var reach = 0.5;
    if (d > reach) {
      var over = d - reach;
      var soft = reach + over * 0.22 / (1 + over * 0.6);
      hx = G.x + dx / d * soft; hy = G.y + dy / d * soft;
    }
    hy = clamp(hy, 0.62, 1.42);
    this.hand = { x: hx, y: hy };
    return this.hand;
  };

  Renderer.prototype._syncAngler = function () {
    var g = this.game;
    var hand = this.hand || g.grip;
    var lean = clamp((hand.x - g.grip.x) * 0.35, -0.16, 0.16);
    var shoulder = { x: g.grip.x + 0.40 + lean * 0.5, y: 1.26, z: 0.31 };
    this.torso.rotation.z = -0.08 - lean;
    this.head.position.x = g.grip.x + 0.33 + lean * 0.45;
    this.cap.position.x = this.head.position.x;
    this.peak.position.x = this.head.position.x - 0.12;
    // Elbow hangs below the shoulder-to-hand line so the arm bends, not swings.
    var hx = hand.x + 0.02, hy = hand.y + 0.02;
    var elbow = { x: (shoulder.x + hx) / 2 + 0.10, y: (shoulder.y + hy) / 2 - 0.14, z: 0.20 };
    this.armRod.set([shoulder, elbow, { x: hx, y: hy, z: 0.02 }]);

    if (g.phase === 'netting') {
      var m = g.netMouth(g.netProgress);
      var p = g.netProgress;
      this.net.position.set(m.x, m.y, 0);
      this.net.rotation.set(0, 0, -0.3 + Math.min(1, Math.max(0, (p - 0.58) / 0.30)) * 0.7);
      this.bag.scale.y = p > 0.55 ? 1.35 : 1;
      this.armNet.set([{ x: g.grip.x + 0.30, y: 1.22, z: 0.30 }, { x: m.x + 0.52, y: m.y + 0.02, z: 0.05 }]);
      this.armNet.mesh.visible = true;
    } else {
      this.net.position.set(g.grip.x + 0.55, 0.98, 0.34);
      this.net.rotation.set(0.9, 0.3, -0.5);
      this.bag.scale.y = 1;
      this.armNet.mesh.visible = false;
    }
  };

  Renderer.prototype._syncFish = function () {
    var g = this.game;
    var fishes = g.school.fish;
    var blind = !!g.river.preset.blind;
    if (!this.fishMeshes) { this.fishMeshes = []; this.texCache = {}; }
    while (this.fishMeshes.length < fishes.length) {
      var fm = new FishMesh(fishes[this.fishMeshes.length].species, this.texCache);
      this.scene.add(fm.group);
      this.fishMeshes.push(fm);
    }
    for (var i = 0; i < this.fishMeshes.length; i++) {
      var fm2 = this.fishMeshes[i];
      var f = fishes[i];
      if (!f || !f.visible()) { fm2.group.visible = false; continue; }
      var shown = f.state === 'hooked' || f.state === 'netting' || g.showLies || !blind;
      if (!shown) { fm2.group.visible = false; continue; }
      // A school reset can swap species under an existing mesh.
      if (fm2.species !== f.species) {
        fm2.species = f.species;
        if (!this.texCache[f.species.key]) this.texCache[f.species.key] = fishTexture(f.species);
        fm2.body.mesh.material.map = this.texCache[f.species.key];
        fm2.body.mesh.material.needsUpdate = true;
      }
      fm2.group.visible = true;
      var L = f.lengthCm / 100;
      var hooked = f.state === 'hooked';
      var rate = hooked ? 13 : 4.2;
      var amp = (hooked ? 0.055 : 0.022) * (0.6 + 0.4 * Math.sin(this.t * 0.7 + f.index));
      fm2.pose(L, this.t * rate + f.index * 1.9, amp);
      // Nose points into the current; hooked fish follow their velocity.
      var heading = Math.PI;
      if (hooked && Math.hypot(f.vx, f.vy) > 0.15) heading = Math.atan2(0, -f.vx) + (f.vx > 0 ? 0 : Math.PI) ;
      if (hooked) heading = f.vx > 0.1 ? 0 : Math.PI;
      var pitch = (hooked || f.airborne) ? -Math.atan2(f.vy, Math.abs(f.vx) + 0.3) * (heading === 0 ? -1 : 1) : 0;
      fm2.group.position.set(f.x, f.y, 0);
      fm2.group.rotation.set(0, heading, pitch);
      // Hidden-but-drawn holding fish in learning mode look ghosted.
      var ghost = f.state === 'holding' && !g.showLies;
      fm2.body.mesh.material.opacity = ghost ? 0.5 : 1;
      fm2.body.mesh.material.transparent = ghost;
    }
  };

  Renderer.prototype._syncLies = function () {
    if (!this.lieMarks) return;
    for (var i = 0; i < this.lieMarks.length; i++) this.lieMarks[i].visible = !!this.game.showLies;
  };

  Renderer.prototype.draw = function () {
    this._syncTackle();
    this._syncAngler();
    this._syncFish();
    this._syncLies();
    var r = this.renderer;
    r.shadowMap.needsUpdate = true;               // once, shared by all three passes
    // Reflection: the scene above the water seen from the mirrored camera.
    this._updateMirrorCamera();
    this.water.visible = false;
    r.clippingPlanes = [this.clipAbove];
    r.setRenderTarget(this.reflRT);
    r.render(this.scene, this.mirrorCam);
    // Refraction: what is under the surface, with depth for absorption.
    r.clippingPlanes = [this.clipBelow];
    r.setRenderTarget(this.refrRT);
    r.render(this.scene, this.camera);
    // The view itself.
    r.clippingPlanes = [];
    r.setRenderTarget(null);
    this.water.visible = true;
    r.render(this.scene, this.camera);
  };

  // ---- main.js interface ---------------------------------------------------

  Renderer.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    var mobile = Math.min(w, h) < 600;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Hold the horizontal field of view instead of the vertical one, so a
    // phone held upright still sees the whole drift rather than a slice of it.
    var halfH = Math.tan(27 * Math.PI / 180);
    var fovV = 2 * Math.atan(halfH / this.camera.aspect) * 180 / Math.PI;
    this.camera.fov = clamp(fovV, 36, 85);
    this.camera.updateProjectionMatrix();
    var db = this.renderer.getDrawingBufferSize(new T.Vector2());
    var rw = Math.max(64, Math.round(db.x * 0.5)), rh = Math.max(64, Math.round(db.y * 0.5));
    this.reflRT.setSize(Math.round(rw * 0.8), Math.round(rh * 0.8));
    this.refrRT.setSize(rw, rh);
    var u = this.waterMat.uniforms;
    u.uRes.value.set(db.x, db.y);
    u.uNear.value = this.camera.near; u.uFar.value = this.camera.far;
    this._placeCamera();
  };

  /** Pointer → the rig plane (z = 0), so the rod follows the finger. */
  Renderer.prototype.toWorld = function (px, py) {
    var rect = this.canvas.getBoundingClientRect();
    var ndc = new T.Vector2((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);
    if (!this._ray) { this._ray = new T.Raycaster(); this._plane = new T.Plane(new T.Vector3(0, 0, 1), 0); this._hit = new T.Vector3(); }
    this._ray.setFromCamera(ndc, this.camera);
    if (this._ray.ray.intersectPlane(this._plane, this._hit)) return { x: this._hit.x, y: this._hit.y };
    return { x: this.game.tipTarget.x, y: this.game.tipTarget.y };
  };

  // The 2D view exposed these for the depth ruler and tests; keep them honest
  // by projecting through the camera.
  Renderer.prototype.sx = function (x) {
    var v = new T.Vector3(x, 0, 0).project(this.camera);
    return (v.x + 1) / 2 * this.canvas.getBoundingClientRect().width;
  };
  Renderer.prototype.sy = function (y) {
    var v = new T.Vector3(this.game.tip.x, y, 0).project(this.camera);
    return (1 - v.y) / 2 * this.canvas.getBoundingClientRect().height;
  };

  EN.Renderer = Renderer;
  EN.DynTube = DynTube;
})(window.EN = window.EN || {});
