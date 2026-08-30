/*
 * render.js — canvas drawing for the river, the rig and the fish.
 *
 * Drifting particles are advected by the same velocity field the leader feels,
 * so what you see on screen really is what is pushing your bugs around.
 */
(function (EN) {
  'use strict';

  var W = EN.WORLD;

  function Renderer(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.particles = [];
    this.foam = [];
    this.t = 0;
    this.resize();
    this._vis = this.visibleRange();
    this._seedParticles(260);
    this.bubbles = [];
    this.rings = [];
    this.droplets = [];
    this._wasWet = false;
  }

  // Metres of river to keep across the canvas, and where the eye should sit.
  var VIEW_WIDTH = 6.2;
  var FOCUS_X = 4.35;

  Renderer.prototype.resize = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    var rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cw = rect.width;
    this.ch = rect.height;
    this._bedKey = null;      // camera moved, so the baked bed is stale
    this._vignette = null;
    this.fit();
  };

  /**
   * Frame the beat: deep water gets pulled back, a shallow riffle gets pushed
   * in, so the picture is never mostly empty sky.
   */
  Renderer.prototype.fit = function () {
    var depth = (this.game.river.maxDepth || 1.0) + 0.35;
    var worldH = W.yTop + depth;
    // A tall, narrow window (a phone held upright) gets a closer view so the rig
    // is still big enough to read. Sideways is better, but this is usable. The
    // focus slides downstream with the zoom to keep both ends of a drift in
    // frame: where the flies land, and the angler they finish at.
    var viewW = this.ch > this.cw ? VIEW_WIDTH * 0.82 : VIEW_WIDTH;
    var focus = FOCUS_X + (VIEW_WIDTH - viewW) * 0.40;
    this.scale = Math.min(this.cw / viewW, this.ch / worldH);
    this.ox = this.cw * 0.5 - focus * this.scale;
    this.oy = (this.ch - worldH * this.scale) / 2;
    this._fitKey = this.game.river.preset.key;
  };

  Renderer.prototype.sx = function (x) { return this.ox + x * this.scale; };
  Renderer.prototype.sy = function (y) { return this.oy + (W.yTop - y) * this.scale; };
  Renderer.prototype.toWorld = function (px, py) {
    return { x: (px - this.ox) / this.scale, y: W.yTop - (py - this.oy) / this.scale };
  };

  /**
   * The stretch of river actually on screen. A wide, short window (a phone held
   * sideways in full screen) shows more river than the beat defines, so the bed
   * has to be drawn to the edge of the glass rather than to a fixed world span.
   */
  Renderer.prototype.visibleRange = function () {
    return { min: this.toWorld(0, 0).x, max: this.toWorld(this.cw, 0).x };
  };

  Renderer.prototype._seedParticles = function (n) {
    var v = this.visibleRange();
    this.particles.length = 0;
    for (var i = 0; i < n; i++) {
      this.particles.push({
        x: v.min + Math.random() * (v.max - v.min),
        y: -Math.random() * 1.6,
        len: 0.06 + Math.random() * 0.16,
        a: 0.05 + Math.random() * 0.18
      });
    }
  };

  Renderer.prototype.update = function (dt) {
    this.t += dt;
    var river = this.game.river;
    if (this._fitKey !== river.preset.key) this.fit();
    this._vis = this.visibleRange();
    this._updateBubbles(dt);
    this._updateRings(dt);
    this._updateDroplets(dt);
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      var bed = river.bedY(p.x);
      if (p.y < bed) p.y = bed + 0.02;
      p.x += river.speedAt(p.x, p.y) * dt;
      if (p.x > this._vis.max) {
        p.x = this._vis.min - Math.random() * 0.4;
        p.y = -Math.random() * Math.max(0.15, river.depth(p.x) * 0.98);
      }
    }
  };

  /** Air dragged under by broken water, working its way back up. */
  Renderer.prototype._updateBubbles = function (dt) {
    var river = this.game.river;
    var want = Math.round(18 + (river.preset.turbulence || 0.1) * 190);
    var v = this._vis;
    while (this.bubbles.length < want) {
      var bx = v.min + Math.random() * (v.max - v.min);
      this.bubbles.push({
        x: bx,
        y: river.bedY(bx) + Math.random() * 0.3,
        r: 0.004 + Math.random() * 0.010,
        rise: 0.14 + Math.random() * 0.30
      });
    }
    while (this.bubbles.length > want) this.bubbles.pop();

    for (var i = 0; i < this.bubbles.length; i++) {
      var b = this.bubbles[i];
      b.x += river.speedAt(b.x, b.y) * dt;
      b.y += b.rise * dt;
      if (b.y > -0.01 || b.x > v.max) {
        b.x = v.min + Math.random() * (v.max - v.min) * 0.7;
        b.y = river.bedY(b.x) + Math.random() * 0.25;
      }
    }
  };

  /** Rings spreading from wherever the leader and flies break the surface. */
  Renderer.prototype._updateRings = function (dt) {
    var p = this.game.rig.point();
    var wet = p.y < 0;
    if (wet && !this._wasWet) {
      this.rings.push({ x: p.x, r: 0.01, life: 1, speed: 0.5 + Math.min(1.5, Math.abs(p.vy)) });
    }
    this._wasWet = wet;

    // A fish going out and coming back in throws a great deal more water.
    var fishes = this.game.school.fish;
    for (var f = 0; f < fishes.length; f++) {
      var fi = fishes[f];
      if (fi.state !== 'hooked') { fi._wasAir = false; continue; }
      if (fi.airborne && !fi._wasAir) {
        this.rings.push({ x: fi.x, r: 0.05, life: 1.3, speed: 1.9 });
        this._spray(fi, 16);
      }
      if (!fi.airborne && fi._wasAir) {
        this.rings.push({ x: fi.x, r: 0.06, life: 1.5, speed: 2.4 });
        this.rings.push({ x: fi.x, r: 0.02, life: 1.2, speed: 1.3 });
        this._spray(fi, 22);
      }
      fi._wasAir = fi.airborne;
    }

    for (var i = this.rings.length - 1; i >= 0; i--) {
      var ring = this.rings[i];
      ring.r += ring.speed * dt;
      ring.x += this.game.river.speedAt(ring.x, -0.02) * dt;
      ring.life -= dt * 0.9;
      if (ring.life <= 0) this.rings.splice(i, 1);
    }
  };

  /** Water thrown off a fish clearing the surface. */
  Renderer.prototype._spray = function (f, n) {
    for (var i = 0; i < n; i++) {
      var a = -Math.PI * (0.15 + Math.random() * 0.7);
      var sp = 0.9 + Math.random() * 2.4;
      this.droplets.push({
        x: f.x, y: Math.max(-0.02, f.y),
        vx: Math.cos(a) * sp * (Math.random() < 0.5 ? -1 : 1) * 0.6 + f.vx * 0.35,
        vy: -Math.sin(a) * sp,
        r: 0.004 + Math.random() * 0.008,
        life: 0.5 + Math.random() * 0.6
      });
    }
  };

  Renderer.prototype._updateDroplets = function (dt) {
    for (var i = this.droplets.length - 1; i >= 0; i--) {
      var d = this.droplets[i];
      d.vy -= 9.81 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.life -= dt;
      if (d.life <= 0 || d.y < -0.02) this.droplets.splice(i, 1);
    }
  };

  Renderer.prototype._drawDroplets = function () {
    if (!this.droplets.length) return;
    var ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < this.droplets.length; i++) {
      var d = this.droplets[i];
      ctx.fillStyle = 'rgba(226,244,248,' + Math.min(0.75, d.life).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(this.sx(d.x), this.sy(d.y), Math.max(0.8, d.r * this.scale), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  Renderer.prototype.draw = function () {
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.cw, this.ch);
    this._drawSky();
    this._drawWater();
    this._drawBed();
    this._drawCaustics();
    this._drawShafts();
    this._drawParticles();
    this._drawBubbles();
    if (this.game.showLies) this._drawLies();
    this._drawFish();
    this._drawMurk();
    this._drawHookedFish();
    this._drawSurface();
    this._drawDroplets();
    this._drawAngler();
    this._drawRig();
    this._drawDepthRuler();
    this._drawVignette();
  };

  Renderer.prototype._drawSky = function () {
    var ctx = this.ctx;
    var horizon = this.sy(0);
    var g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, '#16212c');
    g.addColorStop(0.55, '#283a46');
    g.addColorStop(1, '#43545c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.cw, horizon);

    var x, h;
    // Far ridge, hazed out by distance.
    ctx.fillStyle = 'rgba(46,66,72,0.75)';
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    for (x = 0; x <= this.cw; x += 20) {
      h = horizon * 0.44 + Math.sin(x * 0.0032 + 0.6) * horizon * 0.10
        + Math.sin(x * 0.0071 + 2.2) * horizon * 0.05;
      ctx.lineTo(x, horizon - h);
    }
    ctx.lineTo(this.cw, horizon);
    ctx.closePath();
    ctx.fill();

    // Near bank: bush right down to the water.
    ctx.fillStyle = 'rgba(25,44,37,0.95)';
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    for (x = 0; x <= this.cw; x += 14) {
      h = horizon * 0.17 + Math.sin(x * 0.010) * horizon * 0.05
        + Math.sin(x * 0.027 + 1.7) * horizon * 0.025
        + Math.sin(x * 0.061 + 0.4) * horizon * 0.012;
      ctx.lineTo(x, horizon - h);
    }
    ctx.lineTo(this.cw, horizon);
    ctx.closePath();
    ctx.fill();
  };

  Renderer.prototype._drawWater = function () {
    var ctx = this.ctx;
    var w = this.game.river.preset.water
         || { surface: '#2c5a63', mid: '#1d4048', deep: '#12292f' };
    var top = this.sy(0);
    var g = ctx.createLinearGradient(0, top, 0, this.ch);
    g.addColorStop(0, w.surface);
    g.addColorStop(0.55, w.mid);
    g.addColorStop(1, w.deep);
    ctx.fillStyle = g;
    ctx.fillRect(0, top, this.cw, this.ch - top);
  };

  /**
   * Water you cannot see into. Peat stain and aerated white water both hide a
   * trout completely, so the murk is drawn over the bed and over any fish that
   * has not been hooked — leaving the sighter as the only thing reporting back.
   */
  Renderer.prototype._drawMurk = function () {
    var preset = this.game.river.preset;
    var murk = preset.murk || 0;
    if (murk <= 0) return;

    var ctx = this.ctx;
    var w = preset.water;
    var top = this.sy(0);
    var deepest = this.sy(-(this.game.river.maxDepth || 1));
    var g = ctx.createLinearGradient(0, top, 0, deepest);
    g.addColorStop(0, this._rgba(w.surface, murk * 0.28));
    g.addColorStop(0.45, this._rgba(w.mid, murk * 0.82));
    g.addColorStop(1, this._rgba(w.deep, murk));
    ctx.fillStyle = g;
    ctx.fillRect(0, top, this.cw, this.ch - top);
  };

  Renderer.prototype._rgba = function (hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255)
         + ',' + Math.max(0, Math.min(1, a)).toFixed(3) + ')';
  };

  /**
   * Sunlight coming through the surface. Broken water breaks the shafts up;
   * a smooth glide lets them run right to the stones.
   */
  Renderer.prototype._drawShafts = function () {
    var preset = this.game.river.preset;
    if (preset.murk > 0.6) return;              // nothing gets through peat
    var ctx = this.ctx;
    var v = this._vis;
    var top = this.sy(0);
    var chop = 1 - Math.min(0.8, (preset.turbulence || 0.1) * 2.2);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 7; i++) {
      var phase = i * 1.7;
      var x = v.min + ((i + 0.5) / 7) * (v.max - v.min)
            + Math.sin(this.t * 0.22 + phase) * 0.28;
      var w = (0.22 + Math.sin(phase) * 0.06) * this.scale;
      var depth = this.sy(this.game.river.bedY(x));
      var g = ctx.createLinearGradient(0, top, 0, depth);
      g.addColorStop(0, 'rgba(190,230,236,' + (0.055 * chop).toFixed(3) + ')');
      g.addColorStop(0.5, 'rgba(190,230,236,' + (0.026 * chop).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(190,230,236,0)');
      ctx.fillStyle = g;
      var sxp = this.sx(x);
      ctx.beginPath();
      ctx.moveTo(sxp - w * 0.9, top);
      ctx.lineTo(sxp + w * 0.9, top);
      ctx.lineTo(sxp + w * 1.5, depth);
      ctx.lineTo(sxp - w * 1.5, depth);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  };

  /** The net of light the surface throws across the stones. */
  Renderer.prototype._drawCaustics = function () {
    var river = this.game.river;
    var preset = river.preset;
    if (preset.murk > 0.6) return;
    var ctx = this.ctx;
    var v = this._vis;
    var strength = 0.14 * (1 - Math.min(0.75, (preset.murk || 0) * 1.1));

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (var k = 0; k < 3; k++) {
      ctx.strokeStyle = 'rgba(198,236,240,' + (strength * (1 - k * 0.28)).toFixed(3) + ')';
      ctx.lineWidth = Math.max(1, (0.012 + k * 0.006) * this.scale);
      ctx.beginPath();
      var first = true;
      for (var x = v.min; x <= v.max; x += 0.05) {
        var bed = river.bedY(x);
        // The pattern crawls downstream with the water above it.
        var wob = Math.sin(x * (9 - k * 2) - this.t * (1.5 + k * 0.6)) * 0.022
                + Math.sin(x * (17 + k * 3) + this.t * 0.9) * 0.012;
        var y = bed + 0.02 + wob;
        if (first) { ctx.moveTo(this.sx(x), this.sy(y)); first = false; }
        else ctx.lineTo(this.sx(x), this.sy(y));
      }
      ctx.stroke();
    }
    ctx.restore();
  };

  Renderer.prototype._drawBubbles = function () {
    var ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < this.bubbles.length; i++) {
      var b = this.bubbles[i];
      var r = Math.max(0.7, b.r * this.scale);
      ctx.fillStyle = 'rgba(214,240,244,0.30)';
      ctx.beginPath();
      ctx.arc(this.sx(b.x), this.sy(b.y), r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  /** A quiet darkening at the corners, so the eye sits in the middle. */
  Renderer.prototype._drawVignette = function () {
    var ctx = this.ctx;
    if (!this._vignette) {
      this._vignette = ctx.createRadialGradient(
        this.cw * 0.5, this.ch * 0.48, Math.min(this.cw, this.ch) * 0.34,
        this.cw * 0.5, this.ch * 0.48, Math.max(this.cw, this.ch) * 0.80);
      this._vignette.addColorStop(0, 'rgba(0,0,0,0)');
      this._vignette.addColorStop(1, 'rgba(0,0,0,0.26)');
    }
    ctx.fillStyle = this._vignette;
    ctx.fillRect(0, 0, this.cw, this.ch);
  };

  Renderer.prototype._drawParticles = function () {
    var ctx = this.ctx;
    var river = this.game.river;
    ctx.lineCap = 'round';
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      var u = river.speedAt(p.x, p.y);
      var len = p.len * (0.3 + u);
      ctx.strokeStyle = 'rgba(190,226,232,' + (p.a * (0.35 + u * 0.7)).toFixed(3) + ')';
      ctx.lineWidth = Math.max(0.6, 1.1 * this.scale / 90);
      ctx.beginPath();
      ctx.moveTo(this.sx(p.x - len), this.sy(p.y));
      ctx.lineTo(this.sx(p.x), this.sy(p.y));
      ctx.stroke();
    }
  };

  Renderer.prototype._bakeBed = function () {
    var ctx = this.bedCtx;
    var river = this.game.river;
    var v = this.visibleRange();
    var x0 = v.min - 0.3, x1 = v.max + 0.3;
    ctx.beginPath();
    ctx.moveTo(this.sx(x0), this.ch);
    for (var x = x0; x <= x1; x += 0.08) {
      ctx.lineTo(this.sx(x), this.sy(river.bedY(x)));
    }
    ctx.lineTo(this.sx(x1), this.ch);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, this.sy(-0.3), 0, this.ch);
    g.addColorStop(0, '#3b3a30');
    g.addColorStop(1, '#22211c');
    ctx.fillStyle = g;
    ctx.fill();

    // Cobble texture, deterministic so it does not shimmer. Light comes from
    // above and slightly upstream, so every stone is lit and shadowed the same
    // way the rocks and the fish are.
    ctx.save();
    ctx.clip();
    for (var i = 0; i < 260; i++) {
      var rx = x0 + ((i * 0.6180339887) % 1) * (x1 - x0);
      var depthOffset = ((i * 0.2794) % 1) * 0.40;
      var ry = river.bedY(rx) - depthOffset;
      var jitter = ((i * 0.7311) % 1);
      var rr = (0.022 + jitter * 0.075) * this.scale;
      var shade = 0.55 + ((i * 0.3141) % 1) * 0.45;
      var algae = ((i * 0.113) % 1) < 0.22;

      var base = algae
        ? 'rgba(' + Math.round(74 * shade) + ',' + Math.round(88 * shade) + ',' + Math.round(52 * shade) + ',0.62)'
        : 'rgba(' + Math.round(126 * shade) + ',' + Math.round(116 * shade) + ',' + Math.round(96 * shade) + ',0.55)';
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.ellipse(this.sx(rx), this.sy(ry), rr, rr * (0.62 + jitter * 0.2), jitter * 1.4, 0, Math.PI * 2);
      ctx.fill();

      // Top-lit rim and the crevice under it.
      ctx.fillStyle = 'rgba(214,206,182,' + (0.13 * shade).toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(this.sx(rx), this.sy(ry) - rr * 0.22, rr * 0.72, rr * 0.30, 0, Math.PI, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(12,14,12,0.20)';
      ctx.beginPath();
      ctx.ellipse(this.sx(rx), this.sy(ry) + rr * 0.34, rr * 0.80, rr * 0.24, 0, 0, Math.PI);
      ctx.fill();
    }

    // Sediment hanging in the slow water right at the stones.
    var hazeTop = ctx.createLinearGradient(0, this.sy(-0.05), 0, this.ch);
    hazeTop.addColorStop(0, 'rgba(120,106,80,0)');
    hazeTop.addColorStop(1, 'rgba(120,106,80,0.18)');
    ctx.fillStyle = hazeTop;
    ctx.fillRect(0, this.sy(0), this.cw, this.ch - this.sy(0));
    ctx.restore();

    var rocks = river.preset.rocks || [];
    for (var r = 0; r < rocks.length; r++) {
      var rock = rocks[r];
      var cy = river.bedY(rock.x) + rock.r * 0.55;
      var rad = rock.r * this.scale;
      var cxs = this.sx(rock.x), cys = this.sy(cy);

      // Contact shadow pooling downstream of the stone.
      ctx.fillStyle = 'rgba(8,10,10,0.34)';
      ctx.beginPath();
      ctx.ellipse(cxs + rad * 0.25, cys + rad * 0.66, rad * 1.15, rad * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();

      var rg = ctx.createRadialGradient(
        cxs - rad * 0.38, cys - rad * 0.48, rad * 0.12,
        cxs, cys, rad * 1.05);
      rg.addColorStop(0, '#8b8470');
      rg.addColorStop(0.55, '#5a5648');
      rg.addColorStop(1, '#26251f');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.ellipse(cxs, cys, rad, rad * 0.84, 0, 0, Math.PI * 2);
      ctx.fill();

      // Wet sheen on the crown, weed streaming off the back.
      ctx.fillStyle = 'rgba(226,236,232,0.16)';
      ctx.beginPath();
      ctx.ellipse(cxs - rad * 0.28, cys - rad * 0.44, rad * 0.42, rad * 0.16, -0.35, 0, Math.PI * 2);
      ctx.fill();

    }
  };

  Renderer.prototype._drawBed = function () {
    // The stones do not move, so they are drawn once into an offscreen canvas
    // and blitted. Only the weed trailing off the rocks is animated.
    var key = this.game.river.preset.key + '|' + this.scale.toFixed(2) + '|'
            + this.ox.toFixed(1) + '|' + this.oy.toFixed(1) + '|' + this.cw + 'x' + this.ch;
    if (this._bedKey !== key) {
      if (!this.bedCanvas) this.bedCanvas = document.createElement('canvas');
      this.bedCanvas.width = Math.max(1, Math.round(this.cw * this.dpr));
      this.bedCanvas.height = Math.max(1, Math.round(this.ch * this.dpr));
      this.bedCtx = this.bedCanvas.getContext('2d');
      this.bedCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.bedCtx.clearRect(0, 0, this.cw, this.ch);
      this._bakeBed();
      this._bedKey = key;
    }
    this.ctx.drawImage(this.bedCanvas, 0, 0, this.cw, this.ch);
    this._drawWeed();
  };

  Renderer.prototype._drawWeed = function () {
    var ctx = this.ctx;
    var river = this.game.river;
    var rocks = river.preset.rocks || [];
    ctx.strokeStyle = 'rgba(58,86,52,0.42)';
    ctx.lineCap = 'round';
    for (var r = 0; r < rocks.length; r++) {
      var rock = rocks[r];
      var cy = river.bedY(rock.x) + rock.r * 0.55;
      var rad = rock.r * this.scale;
      var cxs = this.sx(rock.x), cys = this.sy(cy);
      ctx.lineWidth = Math.max(1, rad * 0.07);
      for (var w = 0; w < 3; w++) {
        var sway = Math.sin(this.t * 2.4 + w * 1.3 + r) * rad * 0.14;
        ctx.beginPath();
        ctx.moveTo(cxs + rad * 0.7, cys - rad * 0.1 + w * rad * 0.22);
        ctx.quadraticCurveTo(cxs + rad * 1.25, cys + sway + w * rad * 0.2,
                             cxs + rad * 1.75, cys + sway * 1.6 + w * rad * 0.18);
        ctx.stroke();
      }
    }
  };

  Renderer.prototype._drawLies = function () {
    var ctx = this.ctx;
    var river = this.game.river;
    var lies = river.preset.lies;
    for (var i = 0; i < lies.length; i++) {
      var lie = lies[i];
      var y = river.bedY(lie.x) + 0.16;
      var r = (0.34 + lie.quality * 0.14) * this.scale;
      ctx.strokeStyle = 'rgba(255,214,120,0.35)';
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(this.sx(lie.x), this.sy(y), r, r * 0.62, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,214,120,0.6)';
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(lie.name, this.sx(lie.x), this.sy(y) - r * 0.7 - 6);
    }
  };

  Renderer.prototype._drawFish = function () {
    var fishes = this.game.school.fish;
    var blind = !!this.game.river.preset.blind;
    for (var i = 0; i < fishes.length; i++) {
      var f = fishes[i];
      if (!f.visible() || f.state === 'hooked') continue;
      // On blind water nothing shows at all, including a fish with your fly in
      // its mouth. Learning mode is the way to see what you are missing.
      if (blind && !this.game.showLies) continue;
      var hidden = f.state === 'holding' && !this.game.showLies;
      this._drawOneFish(f, hidden ? 0.16 : 1);
    }
  };

  /** A hooked fish is up in the water and thrashing — you see that anywhere. */
  Renderer.prototype._drawHookedFish = function () {
    var ctx = this.ctx;
    var fishes = this.game.school.fish;
    for (var i = 0; i < fishes.length; i++) {
      var f = fishes[i];
      if (f.state !== 'hooked') continue;
      if (f.airborne) {
        // Clear of the water it catches the light and throws a shadow of spray.
        ctx.save();
        ctx.shadowColor = 'rgba(206,236,244,0.55)';
        ctx.shadowBlur = 14;
        this._drawOneFish(f, 1);
        ctx.restore();
      } else {
        this._drawOneFish(f, 1);
      }
    }
  };

  // Half-height down the body, nose to tail wrist. This profile is what makes
  // the silhouette read as a trout rather than a generic fish.
  var BODY = [
    [0.00, 0.020], [0.05, 0.075], [0.12, 0.118], [0.22, 0.150], [0.32, 0.161],
    [0.45, 0.152], [0.58, 0.130], [0.70, 0.103], [0.82, 0.072], [0.91, 0.048],
    [1.00, 0.030]
  ];

  function halfHeight(s) {
    for (var i = 1; i < BODY.length; i++) {
      if (s <= BODY[i][0]) {
        var a = BODY[i - 1], b = BODY[i];
        var t = (s - a[0]) / (b[0] - a[0]);
        return a[1] + (b[1] - a[1]) * t;
      }
    }
    return BODY[BODY.length - 1][1];
  }

  Renderer.prototype._drawOneFish = function (f, alpha) {
    var ctx = this.ctx;
    var L = (f.lengthCm / 100) * this.scale;
    var x = this.sx(f.x), y = this.sy(f.y);

    // Trout hold facing into the current, so upstream is the default heading.
    var heading = Math.PI + Math.atan2(-(f.vy || 0), -(f.vx || -0.01) - 0.4);

    // The whole body swims, not just the tail. A hooked fish thrashes.
    var hooked = f.state === 'hooked';
    var rate = hooked ? 13 : 4.2;
    var amp = (hooked ? 0.055 : 0.022) * (0.6 + 0.4 * Math.sin(this.t * 0.7 + f.index));
    var phase = this.t * rate + f.index * 1.9;

    function spine(s) { return amp * Math.sin(s * 5.2 - phase) * (0.12 + s * 0.88); }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(heading);
    ctx.scale(L, L);           // work in body lengths from here on

    var i, s2, h, yc;

    // ---- fins behind the body -------------------------------------------
    ctx.fillStyle = f.species.fin || 'rgba(120,104,74,0.85)';
    // Pectoral
    ctx.beginPath();
    ctx.moveTo(0.20, 0.06);
    ctx.quadraticCurveTo(0.30, 0.16, 0.34, 0.10);
    ctx.quadraticCurveTo(0.28, 0.08, 0.20, 0.06);
    ctx.fill();
    // Pelvic and anal
    ctx.beginPath();
    ctx.moveTo(0.46, 0.12);
    ctx.quadraticCurveTo(0.55, 0.21, 0.60, 0.13);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0.66, 0.10);
    ctx.quadraticCurveTo(0.73, 0.18, 0.78, 0.09);
    ctx.fill();

    // ---- caudal fin -------------------------------------------------------
    var tailY = spine(1);
    ctx.beginPath();
    ctx.moveTo(1.00, tailY - 0.03);
    ctx.quadraticCurveTo(1.13, tailY - 0.16, 1.20, tailY - 0.19);
    ctx.quadraticCurveTo(1.13, tailY, 1.20, tailY + 0.19);
    ctx.quadraticCurveTo(1.13, tailY + 0.16, 1.00, tailY + 0.03);
    ctx.closePath();
    ctx.fill();

    // ---- body -------------------------------------------------------------
    ctx.beginPath();
    for (i = 0; i <= 24; i++) {
      s2 = i / 24;
      h = halfHeight(s2); yc = spine(s2);
      if (i === 0) ctx.moveTo(s2, yc - h); else ctx.lineTo(s2, yc - h);
    }
    for (i = 24; i >= 0; i--) {
      s2 = i / 24;
      h = halfHeight(s2); yc = spine(s2);
      ctx.lineTo(s2, yc + h);
    }
    ctx.closePath();

    // Countershading: dark back, bright flank, pale belly.
    var grad = ctx.createLinearGradient(0, -0.17, 0, 0.17);
    grad.addColorStop(0, f.species.back);
    grad.addColorStop(0.45, f.species.body);
    grad.addColorStop(0.78, f.species.belly);
    grad.addColorStop(1, f.species.belly);
    ctx.fillStyle = grad;
    ctx.fill();

    // Dorsal and adipose sit on top of the body.
    ctx.fillStyle = f.species.fin || 'rgba(120,104,74,0.85)';
    ctx.beginPath();
    ctx.moveTo(0.34, spine(0.34) - 0.15);
    ctx.quadraticCurveTo(0.44, spine(0.4) - 0.30, 0.52, spine(0.52) - 0.14);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0.80, spine(0.8) - 0.075);
    ctx.quadraticCurveTo(0.85, spine(0.82) - 0.13, 0.88, spine(0.88) - 0.055);
    ctx.closePath();
    ctx.fill();

    ctx.save();
    ctx.clip();

    // Lateral line and the flank sheen along it.
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 0.012;
    ctx.beginPath();
    for (i = 0; i <= 24; i++) {
      s2 = i / 24;
      var ly = spine(s2) + halfHeight(s2) * 0.12;
      if (i === 0) ctx.moveTo(s2, ly); else ctx.lineTo(s2, ly);
    }
    ctx.stroke();

    // Spots, denser along the back, deterministic per fish.
    for (i = 0; i < 34; i++) {
      var ss = 0.10 + ((i * 0.6180339887) % 1) * 0.82;
      var band = ((i * 0.3178) % 1) - 0.5;
      var sy2 = spine(ss) + band * halfHeight(ss) * 1.5;
      var rad = 0.010 + ((i * 0.2113) % 1) * 0.012;
      var red = f.species.redSpots && (i % 5 === 0) && band > -0.15;
      ctx.fillStyle = red ? f.species.redSpot : f.species.spot;
      ctx.globalAlpha = alpha * (red ? 0.85 : (band < 0 ? 0.75 : 0.4));
      ctx.beginPath();
      ctx.arc(ss, sy2, rad, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.restore();

    // ---- head -------------------------------------------------------------
    // Gill plate
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 0.010;
    ctx.beginPath();
    ctx.moveTo(0.16, spine(0.16) - 0.115);
    ctx.quadraticCurveTo(0.13, spine(0.15), 0.17, spine(0.17) + 0.10);
    ctx.stroke();

    // Mouth
    ctx.beginPath();
    ctx.moveTo(0.005, spine(0) + 0.012);
    ctx.lineTo(0.055, spine(0.05) + 0.028);
    ctx.stroke();

    // Eye
    var ey = spine(0.07) - 0.028;
    ctx.fillStyle = '#e9e2cf';
    ctx.beginPath();
    ctx.arc(0.072, ey, 0.030, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b0b0b';
    ctx.beginPath();
    ctx.arc(0.072, ey, 0.019, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.arc(0.064, ey - 0.009, 0.007, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  };

  /**
   * The film itself: a wave whose height follows the local current, the sky
   * reflected just under it, a specular edge on top, and the small disturbances
   * the tackle makes going through it.
   */
  Renderer.prototype._drawSurface = function () {
    var ctx = this.ctx;
    var river = this.game.river;
    var y0 = this.sy(0);
    var preset = river.preset;
    var self = this;

    function waveAt(px) {
      var wx = self.toWorld(px, 0).x;
      var chop = Math.min(1.4, river.surfaceSpeed(wx) / 1.0)
               * (1 + (preset.turbulence || 0.1) * 2.4);
      return Math.sin(wx * 7 - self.t * 5) * 1.9 * chop
           + Math.sin(wx * 15 + self.t * 3.2) * 1.1 * chop
           + Math.sin(wx * 31 - self.t * 7.5) * 0.5 * chop;
    }

    // Reflection of sky and bank held in the top of the water.
    var refl = ctx.createLinearGradient(0, y0, 0, y0 + 0.30 * this.scale);
    refl.addColorStop(0, 'rgba(150,180,190,0.30)');
    refl.addColorStop(1, 'rgba(150,180,190,0)');
    ctx.fillStyle = refl;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    for (var px = 0; px <= this.cw; px += 6) ctx.lineTo(px, y0 + waveAt(px));
    ctx.lineTo(this.cw, y0 + 0.30 * this.scale);
    ctx.lineTo(0, y0 + 0.30 * this.scale);
    ctx.closePath();
    ctx.fill();

    // Rings from anything that has gone through the film.
    ctx.lineWidth = 1.1;
    for (var i = 0; i < this.rings.length; i++) {
      var ring = this.rings[i];
      var a = Math.max(0, ring.life) * 0.5;
      ctx.strokeStyle = 'rgba(224,244,248,' + a.toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(this.sx(ring.x), y0, ring.r * this.scale,
                  ring.r * this.scale * 0.16, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // The film's bright edge.
    ctx.strokeStyle = 'rgba(214,242,248,0.62)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (px = 0; px <= this.cw; px += 5) {
      var wy = y0 + waveAt(px);
      if (px === 0) ctx.moveTo(px, wy); else ctx.lineTo(px, wy);
    }
    ctx.stroke();

    // Where the leader pierces the surface it pulls a small dimple of light.
    var rig = this.game.rig;
    for (var n = 1; n < rig.nodes.length; n++) {
      var a1 = rig.nodes[n - 1], b1 = rig.nodes[n];
      if ((a1.y > 0) === (b1.y > 0)) continue;
      var f = a1.y / (a1.y - b1.y);
      var cx = a1.x + (b1.x - a1.x) * f;
      ctx.fillStyle = 'rgba(232,248,250,0.42)';
      ctx.beginPath();
      ctx.ellipse(this.sx(cx), y0, 0.05 * this.scale, 0.014 * this.scale, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (!preset.foam) return;
    // Aerated seams peeling off the rocks.
    var rocks = preset.rocks || [];
    ctx.lineCap = 'round';
    for (var r = 0; r < rocks.length; r++) {
      var rock = rocks[r];
      for (var k = 0; k < 6; k++) {
        var phase = this.t * 1.6 + k * 0.7 + r;
        var run = (phase % 1);
        var fx = rock.x + 0.12 + run * 1.6;
        var fy = -0.02 - ((k * 0.37) % 1) * 0.10;
        var fade = (1 - run) * 0.55;
        ctx.strokeStyle = 'rgba(238,250,252,' + fade.toFixed(3) + ')';
        ctx.lineWidth = Math.max(1, 0.022 * this.scale);
        ctx.beginPath();
        ctx.moveTo(this.sx(fx), this.sy(fy));
        ctx.lineTo(this.sx(fx + 0.18), this.sy(fy));
        ctx.stroke();
      }
    }
  };

  /**
   * The angler, as a silhouette. Waders in the water, jacket above, cap peak
   * pointing upstream, net on the back — read as a shape rather than drawn in
   * detail, which is all you would see against a bright river anyway.
   */
  Renderer.prototype._drawAngler = function () {
    var ctx = this.ctx;
    var g = this.game;
    var S = this.scale;
    var gx = this.sx(g.grip.x), gy = this.sy(g.grip.y);
    var X = function (dx) { return gx + dx * S; };
    var Y = function (wy) { return this.sy(wy); }.bind(this);

    var footY = this.sy(g.river.bedY(g.grip.x) + 0.02);
    var hipY = Y(0.42);
    var chestY = Y(1.12);
    var shoulderY = Y(1.34);
    var headY = Y(1.46);

    ctx.save();

    // Net hoop slung on the back.
    ctx.strokeStyle = 'rgba(22,37,43,0.9)';
    ctx.lineWidth = 0.035 * S;
    ctx.beginPath();
    ctx.ellipse(X(0.60), Y(1.00), 0.20 * S, 0.13 * S, -0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(22,37,43,0.35)';
    ctx.fill();

    // Waders: two legs, the far one darker so the stance reads.
    ctx.fillStyle = '#152229';
    ctx.beginPath();
    ctx.moveTo(X(0.44), footY);
    ctx.lineTo(X(0.30), hipY);
    ctx.lineTo(X(0.46), hipY);
    ctx.lineTo(X(0.60), footY);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#1b2c34';
    ctx.beginPath();
    ctx.moveTo(X(0.20), footY);
    ctx.lineTo(X(0.24), hipY);
    ctx.lineTo(X(0.42), hipY);
    ctx.lineTo(X(0.40), footY);
    ctx.closePath();
    ctx.fill();

    // Torso, leaning a little into the river.
    ctx.fillStyle = '#16252b';
    ctx.beginPath();
    ctx.moveTo(X(0.22), hipY);
    ctx.lineTo(X(0.16), chestY);
    ctx.quadraticCurveTo(X(0.18), shoulderY, X(0.30), shoulderY);
    ctx.lineTo(X(0.46), shoulderY);
    ctx.quadraticCurveTo(X(0.54), chestY, X(0.48), hipY);
    ctx.closePath();
    ctx.fill();

    // Wading belt.
    ctx.fillStyle = 'rgba(8,14,17,0.9)';
    ctx.fillRect(X(0.20), hipY - 0.035 * S, 0.29 * S, 0.035 * S);

    // Rod arm, out to the grip.
    ctx.strokeStyle = '#16252b';
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.072 * S;
    ctx.beginPath();
    ctx.moveTo(X(0.36), Y(1.26));
    ctx.quadraticCurveTo(X(0.20), Y(1.14), gx, gy);
    ctx.stroke();

    // Neck, then head and cap sitting on the shoulders.
    ctx.fillStyle = '#16252b';
    ctx.fillRect(X(0.29), shoulderY - 0.06 * S, 0.11 * S, 0.09 * S);
    ctx.beginPath();
    ctx.arc(X(0.34), headY, 0.086 * S, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(X(0.26), headY - 0.052 * S);
    ctx.lineTo(X(0.10), headY - 0.026 * S);
    ctx.lineTo(X(0.27), headY + 0.008 * S);
    ctx.closePath();
    ctx.fill();

    // Rim light down the upstream edge, from the sky behind.
    ctx.strokeStyle = 'rgba(150,180,190,0.30)';
    ctx.lineWidth = Math.max(1, 0.014 * S);
    ctx.beginPath();
    ctx.moveTo(X(0.256), headY - 0.045 * S);
    ctx.lineTo(X(0.256), headY + 0.055 * S);
    ctx.moveTo(X(0.17), chestY);
    ctx.lineTo(X(0.225), hipY);
    ctx.stroke();

    // Where the waders meet the river.
    var wl = this.sy(0);
    ctx.strokeStyle = 'rgba(224,244,248,0.5)';
    ctx.lineWidth = Math.max(1, 0.02 * S);
    ctx.beginPath();
    ctx.moveTo(X(0.14), wl);
    ctx.lineTo(X(0.68), wl);
    ctx.stroke();

    ctx.restore();
    this._drawRod(gx, gy);
  };

  Renderer.prototype._drawRod = function (gx, gy) {
    var ctx = this.ctx;
    var g = this.game;
    var S = this.scale;
    var tx = this.sx(g.tip.x), ty = this.sy(g.tip.y);
    var hud = g.hudState();
    // The rod loads under tension: bend the tip back toward the fish.
    var bend = Math.min(1, hud.tension * 0.9 + g.rig.contact * 0.12) * 0.22 * S;
    var mx = (gx + tx) / 2, my = (gy + ty) / 2;
    var nx = -(ty - gy), ny = (tx - gx);
    var nl = Math.hypot(nx, ny) || 1;
    var c1x = mx + nx / nl * bend, c1y = my + ny / nl * bend;

    // Split the curve at its own midpoint (de Casteljau) so butt and tip meet
    // cleanly instead of kinking.
    var a1x = (gx + c1x) / 2, a1y = (gy + c1y) / 2;
    var b1x = (c1x + tx) / 2, b1y = (c1y + ty) / 2;
    var midx = (a1x + b1x) / 2, midy = (a1y + b1y) / 2;

    // Direction back down the blank, for the grip and reel.
    var ux = (tx - gx), uy = (ty - gy);
    var ul = Math.hypot(ux, uy) || 1;
    ux /= ul; uy /= ul;

    ctx.save();
    ctx.lineCap = 'round';

    ctx.strokeStyle = '#2b3238';
    ctx.lineWidth = Math.max(2.0, 0.030 * S);
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.quadraticCurveTo(a1x, a1y, midx, midy);
    ctx.stroke();

    ctx.strokeStyle = '#8d959b';
    ctx.lineWidth = Math.max(1.0, 0.013 * S);
    ctx.beginPath();
    ctx.moveTo(midx, midy);
    ctx.quadraticCurveTo(b1x, b1y, tx, ty);
    ctx.stroke();

    // Guides down the blank, biggest at the butt.
    ctx.strokeStyle = 'rgba(214,224,230,0.75)';
    for (var i = 1; i <= 6; i++) {
      var f = i / 7;
      var px = gx + (tx - gx) * f + (c1x - (gx + tx) / 2) * (1 - Math.abs(0.5 - f) * 2) * 0.9;
      var py = gy + (ty - gy) * f + (c1y - (gy + ty) / 2) * (1 - Math.abs(0.5 - f) * 2) * 0.9;
      var r = (0.028 - f * 0.017) * S;
      ctx.lineWidth = Math.max(0.8, r * 0.30);
      ctx.beginPath();
      ctx.arc(px - uy * r * 0.9, py + ux * r * 0.9, Math.max(1, r * 0.55), 0, Math.PI * 2);
      ctx.stroke();
    }

    // Cork, then the reel hanging under it.
    ctx.strokeStyle = '#b79a68';
    ctx.lineWidth = Math.max(2.6, 0.042 * S);
    ctx.beginPath();
    ctx.moveTo(gx - ux * 0.10 * S, gy - uy * 0.10 * S);
    ctx.lineTo(gx + ux * 0.16 * S, gy + uy * 0.16 * S);
    ctx.stroke();

    var rx = gx - ux * 0.22 * S, ry = gy - uy * 0.22 * S;
    var rr = 0.085 * S;
    var rg = ctx.createRadialGradient(rx - rr * 0.3, ry - rr * 0.3, rr * 0.15, rx, ry, rr);
    rg.addColorStop(0, '#7d858b');
    rg.addColorStop(1, '#2c3439');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(rx, ry, rr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,26,30,0.9)';
    ctx.lineWidth = Math.max(1, rr * 0.16);
    ctx.beginPath();
    ctx.arc(rx, ry, rr * 0.55, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  };

  Renderer.prototype._drawRig = function () {
    var ctx = this.ctx;
    var rig = this.game.rig;
    var nodes = rig.nodes;
    var n = rig.config.nodes;

    // Butt / running line: dull, low-vis.
    this._strokeRange(nodes, 0, rig.sighterFrom, 'rgba(214,206,178,0.75)', 1.5);
    // Tippet: nearly invisible, just a hint.
    this._strokeRange(nodes, rig.sighterTo, n - 1, 'rgba(200,225,232,0.42)', 1.1);

    // Sighter: bicolor, and it glows so your eye locks onto it.
    ctx.save();
    ctx.lineCap = 'round';
    var bands = ['#ff7a1a', '#ffe14d', '#ff7a1a', '#b6ff5a'];
    var total = rig.sighterTo - rig.sighterFrom;
    for (var i = rig.sighterFrom; i < rig.sighterTo; i++) {
      var a = nodes[i], b = nodes[i + 1];
      var band = bands[Math.floor(((i - rig.sighterFrom) / Math.max(1, total)) * bands.length) % bands.length];
      ctx.shadowColor = band;
      ctx.shadowBlur = 8;
      ctx.strokeStyle = band;
      ctx.lineWidth = 3.0;
      ctx.beginPath();
      ctx.moveTo(this.sx(a.x), this.sy(a.y));
      ctx.lineTo(this.sx(b.x), this.sy(b.y));
      ctx.stroke();
    }
    ctx.restore();

    var d = rig.dropper();
    if (d) {
      var host = nodes[rig.dropperHost];
      ctx.strokeStyle = 'rgba(200,225,232,0.42)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(this.sx(host.x), this.sy(host.y));
      ctx.lineTo(this.sx(d.x), this.sy(d.y));
      ctx.stroke();
      this._drawFly(d, rig.config.dropperBead, '#c0d8c0');
    }
    this._drawFly(rig.point(), rig.config.pointBead, '#d9b24a');
  };

  Renderer.prototype._strokeRange = function (nodes, from, to, color, width) {
    var ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(this.sx(nodes[from].x), this.sy(nodes[from].y));
    for (var i = from + 1; i <= to; i++) ctx.lineTo(this.sx(nodes[i].x), this.sy(nodes[i].y));
    ctx.stroke();
  };

  Renderer.prototype._drawFly = function (node, beadMm, bodyColor) {
    var ctx = this.ctx;
    var r = Math.max(2, (beadMm / 1000) * this.scale * 2.6);
    var x = this.sx(node.x), y = this.sy(node.y);
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.ellipse(x + r * 0.9, y, r * 1.5, r * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
    var g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r);
    g.addColorStop(0, '#fff3c4');
    g.addColorStop(1, '#a8791d');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  /** A quiet scale on the left so depth is readable at a glance. */
  Renderer.prototype._drawDepthRuler = function () {
    var ctx = this.ctx;
    var x = 12;
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    var deepest = this.game.river.maxDepth || 1;
    for (var d = 0; d <= deepest; d += 0.5) {
      var y = this.sy(-d);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 14, y);
      ctx.stroke();
      if (d > 0) ctx.fillText(d.toFixed(1) + ' m', x + 18, y + 3);
    }
  };

  EN.Renderer = Renderer;
})(window.EN = window.EN || {});
