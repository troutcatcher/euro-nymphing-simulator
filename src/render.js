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
  }

  // Metres of river to keep across the canvas, and where the eye should sit.
  var VIEW_WIDTH = 6.2;
  var FOCUS_X = 4.35;

  Renderer.prototype.resize = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cw = rect.width;
    this.ch = rect.height;
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

  Renderer.prototype.draw = function () {
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.cw, this.ch);
    this._drawSky();
    this._drawWater();
    this._drawParticles();
    this._drawBed();
    if (this.game.showLies) this._drawLies();
    this._drawFish();
    this._drawMurk();
    this._drawHookedFish();
    this._drawSurface();
    this._drawAngler();
    this._drawRig();
    this._drawDepthRuler();
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

  Renderer.prototype._drawBed = function () {
    var ctx = this.ctx;
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

    // Cobble texture, deterministic so it does not shimmer.
    ctx.save();
    ctx.clip();
    for (var i = 0; i < 190; i++) {
      var rx = x0 + ((i * 0.6180339887) % 1) * (x1 - x0);
      var depthOffset = ((i * 0.2794) % 1) * 0.34;
      var ry = river.bedY(rx) - depthOffset;
      var rr = (0.03 + ((i * 0.4142) % 1) * 0.06) * this.scale;
      ctx.fillStyle = i % 3 === 0 ? 'rgba(120,112,92,0.35)' : 'rgba(70,66,54,0.45)';
      ctx.beginPath();
      ctx.ellipse(this.sx(rx), this.sy(ry), rr, rr * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    var rocks = river.preset.rocks || [];
    for (var r = 0; r < rocks.length; r++) {
      var rock = rocks[r];
      var cy = river.bedY(rock.x) + rock.r * 0.55;
      var rad = rock.r * this.scale;
      var rg = ctx.createRadialGradient(
        this.sx(rock.x) - rad * 0.3, this.sy(cy) - rad * 0.4, rad * 0.15,
        this.sx(rock.x), this.sy(cy), rad);
      rg.addColorStop(0, '#5d5a4c');
      rg.addColorStop(1, '#2b2a23');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.ellipse(this.sx(rock.x), this.sy(cy), rad, rad * 0.82, 0, 0, Math.PI * 2);
      ctx.fill();
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
    var fishes = this.game.school.fish;
    for (var i = 0; i < fishes.length; i++) {
      if (fishes[i].state === 'hooked') this._drawOneFish(fishes[i], 1);
    }
  };

  Renderer.prototype._drawOneFish = function (f, alpha) {
    var ctx = this.ctx;
    var L = (f.lengthCm / 100) * this.scale;
    var x = this.sx(f.x), y = this.sy(f.y);
    // Trout point into the current, so they face upstream (screen left).
    var heading = Math.PI + Math.atan2(-(f.vy || 0), -(f.vx || -0.01) - 0.4);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(heading);

    ctx.fillStyle = f.species.body;
    ctx.beginPath();
    ctx.ellipse(0, 0, L * 0.5, L * 0.145, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = f.species.belly;
    ctx.globalAlpha = alpha * 0.55;
    ctx.beginPath();
    ctx.ellipse(0, L * 0.055, L * 0.42, L * 0.075, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;

    // Tail
    var wag = Math.sin(this.t * (f.state === 'hooked' ? 16 : 5) + f.index) * 0.35;
    ctx.save();
    ctx.translate(L * 0.48, 0);
    ctx.rotate(wag);
    ctx.fillStyle = f.species.body;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(L * 0.20, -L * 0.14);
    ctx.lineTo(L * 0.15, 0);
    ctx.lineTo(L * 0.20, L * 0.14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Dorsal + adipose
    ctx.fillStyle = f.species.spot;
    ctx.beginPath();
    ctx.moveTo(-L * 0.02, -L * 0.13);
    ctx.lineTo(L * 0.14, -L * 0.24);
    ctx.lineTo(L * 0.16, -L * 0.12);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = alpha * 0.7;
    for (var s = 0; s < 7; s++) {
      var sx = -L * 0.3 + s * L * 0.1;
      ctx.beginPath();
      ctx.arc(sx, Math.sin(s * 2.1) * L * 0.05, L * 0.018, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = alpha;

    ctx.fillStyle = '#0d0d0d';
    ctx.beginPath();
    ctx.arc(-L * 0.42, -L * 0.03, L * 0.026, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  Renderer.prototype._drawSurface = function () {
    var ctx = this.ctx;
    var river = this.game.river;
    var y0 = this.sy(0);
    ctx.strokeStyle = 'rgba(206,238,244,0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (var px = 0; px <= this.cw; px += 6) {
      var wx = this.toWorld(px, 0).x;
      var chop = Math.min(1, river.surfaceSpeed(wx) / 1.2);
      var wave = Math.sin(wx * 7 - this.t * 5) * 1.6 * chop
               + Math.sin(wx * 15 + this.t * 3.2) * 0.9 * chop;
      if (px === 0) ctx.moveTo(px, y0 + wave); else ctx.lineTo(px, y0 + wave);
    }
    ctx.stroke();

    if (!river.preset.foam) return;
    // Aerated seams peeling off the rocks.
    var rocks = river.preset.rocks || [];
    ctx.lineCap = 'round';
    for (var r = 0; r < rocks.length; r++) {
      var rock = rocks[r];
      for (var k = 0; k < 5; k++) {
        var phase = this.t * 1.6 + k * 0.7 + r;
        var run = (phase % 1);
        var fx = rock.x + 0.12 + run * 1.5;
        var fy = -0.02 - ((k * 0.37) % 1) * 0.09;
        var fade = (1 - run) * 0.5;
        ctx.strokeStyle = 'rgba(233,246,248,' + fade.toFixed(3) + ')';
        ctx.lineWidth = Math.max(1, 0.02 * this.scale);
        ctx.beginPath();
        ctx.moveTo(this.sx(fx), this.sy(fy));
        ctx.lineTo(this.sx(fx + 0.16), this.sy(fy));
        ctx.stroke();
      }
    }
  };

  Renderer.prototype._drawAngler = function () {
    var ctx = this.ctx;
    var g = this.game;
    var gx = this.sx(g.grip.x), gy = this.sy(g.grip.y);
    var footY = this.sy(g.river.bedY(g.grip.x));
    var hipY = this.sy(0.35);

    ctx.strokeStyle = '#16252b';
    ctx.fillStyle = '#16252b';
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.085 * this.scale;
    ctx.beginPath();
    ctx.moveTo(gx + 0.34 * this.scale, footY);
    ctx.lineTo(gx + 0.26 * this.scale, hipY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(gx + 0.48 * this.scale, footY);
    ctx.lineTo(gx + 0.30 * this.scale, hipY);
    ctx.stroke();

    ctx.lineWidth = 0.115 * this.scale;
    ctx.beginPath();
    ctx.moveTo(gx + 0.28 * this.scale, hipY);
    ctx.lineTo(gx + 0.33 * this.scale, this.sy(1.22));
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(gx + 0.34 * this.scale, this.sy(1.38), 0.085 * this.scale, 0, Math.PI * 2);
    ctx.fill();

    // Casting arm reaching to the grip.
    ctx.lineWidth = 0.055 * this.scale;
    ctx.beginPath();
    ctx.moveTo(gx + 0.31 * this.scale, this.sy(1.14));
    ctx.lineTo(gx, gy);
    ctx.stroke();

    this._drawRod(gx, gy);
  };

  Renderer.prototype._drawRod = function (gx, gy) {
    var ctx = this.ctx;
    var g = this.game;
    var tx = this.sx(g.tip.x), ty = this.sy(g.tip.y);
    var hud = g.hudState();
    // The rod loads under tension: bend the tip back toward the fish.
    var bend = Math.min(1, hud.tension * 0.9 + g.rig.contact * 0.12) * 0.22 * this.scale;
    var mx = (gx + tx) / 2, my = (gy + ty) / 2;
    var nx = -(ty - gy), ny = (tx - gx);
    var nl = Math.hypot(nx, ny) || 1;

    var c1x = mx + nx / nl * bend, c1y = my + ny / nl * bend;

    // Split the curve at its own midpoint (de Casteljau) so butt and tip meet
    // cleanly instead of kinking.
    var a1x = (gx + c1x) / 2, a1y = (gy + c1y) / 2;
    var b1x = (c1x + tx) / 2, b1y = (c1y + ty) / 2;
    var midx = (a1x + b1x) / 2, midy = (a1y + b1y) / 2;

    ctx.strokeStyle = '#2b3238';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2.0, 0.030 * this.scale);
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.quadraticCurveTo(a1x, a1y, midx, midy);
    ctx.stroke();

    // Tip section, fine and pale so it reads against the water.
    ctx.strokeStyle = '#8d959b';
    ctx.lineWidth = Math.max(1.0, 0.013 * this.scale);
    ctx.beginPath();
    ctx.moveTo(midx, midy);
    ctx.quadraticCurveTo(b1x, b1y, tx, ty);
    ctx.stroke();

    // Cork.
    ctx.strokeStyle = '#b79a68';
    ctx.lineWidth = Math.max(2.6, 0.042 * this.scale);
    var ux = (tx - gx), uy = (ty - gy);
    var ul = Math.hypot(ux, uy) || 1;
    ctx.beginPath();
    ctx.moveTo(gx - ux / ul * 0.10 * this.scale, gy - uy / ul * 0.10 * this.scale);
    ctx.lineTo(gx + ux / ul * 0.16 * this.scale, gy + uy / ul * 0.16 * this.scale);
    ctx.stroke();
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
