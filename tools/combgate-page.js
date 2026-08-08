/*
 * combgate page side. Loaded as raw text and eval'd, so template literals are
 * fine. NOTE: no backtick may appear inside any comment in this file.
 *
 * Purpose: adjudicate the COMBINED state of the render pipeline against the
 * hard constraint p95 <= 16.67 ms, and attribute what is left.
 *
 * Instrument is the rAF interval and nothing else. Deliberately NOT used:
 *   - rp.stats.frameMs   -- a 48-frame rolling MEAN, cannot yield a percentile.
 *   - EXT_disjoint_timer_query_webgl2 -- exposed, returns values, and reports
 *     ~2.2x wall clock under ANGLE/Metal. Not an attribution instrument here.
 *
 * Ablation is by setEffect() ONLY. Writing rp.effects.x = false sets a flag and
 * rebuilds no composer, so the pass keeps running; every arm therefore reports
 * the armed pass list back and the driver asserts on it.
 */
(() => {
  const KB = window.KB;
  const rp = KB.renderer;
  const P = {};
  window.__kbComb = P;

  P._frameNo = 0;

  /* ---------------------------------------------------------------- setup */

  P.setup = (level) => {
    const CPUClass = KB.cpu && KB.cpu[1] ? KB.cpu[1].constructor : null;
    if (!CPUClass) throw new Error('no CPU class');
    if (!P._cpu0) {
      P._cpu0 = new CPUClass(KB.fighters[0], KB.fighters[1], { level: level || 7 });
      const orig = KB.input.commandsFor.bind(KB.input);
      KB.input.commandsFor = (i, f) => (i === 0 ? P._cpu0.think(KB.tick) : orig(i, f));
    }
    KB.cpu[1].setLevel(level || 7);

    if (KB.menus && KB.menus.show) KB.menus.show(null);
    KB.paused = false;
    KB.startMatch(0, 1);
    KB.setPhase('fight');
    KB.fightCamera.cinematic('fight');

    // Keep the fight alive forever: never let a KO or the round clock end it,
    // so every block samples the same kind of seconds.
    if (!P._sustain) {
      P._sustain = true;
      const pump = () => {
        if (KB.phase !== 'fight') KB.setPhase('fight');
        KB.roundTimer = 99 * 60;
        for (const f of KB.fighters) if (f.health < 70) f.health = 180;
        requestAnimationFrame(pump);
      };
      requestAnimationFrame(pump);
    }

    /* HAZARD, caught by this rig's own setup assertion on its first run.
     * Disabling adaptive resolution FREEZES the scale wherever the controller
     * last left it -- it does not restore the tier's renderScale. By the time
     * setup() runs the controller has already walked 'high' down to ~0.77
     * (1478x831), and a run that only sets adaptiveResolution=false measures
     * 26% fewer pixels than the shipped 'high' it claims to be measuring.
     * The tier value must be re-asserted explicitly, and then asserted on. */
    rp.effects.adaptiveResolution = false;
    const want = rp.tier ? rp.tier.renderScale : 0.85;
    rp.renderScale = want;
    rp._targetScale = want;
    rp.resize();

    if (!P._hooked) {
      P._hooked = true;
      const composer = rp.composer;
      const orig = composer.render.bind(composer);
      composer.render = (dt) => { P._frameNo++; orig(dt); };
    }
    return P.state();
  };

  /* ------------------------------------------------------- config capture */

  /**
   * Everything a block needs to prove it measured what it claims to have
   * measured. The armed list is read off the composer, not off rp.effects.
   */
  P.state = () => {
    const b = rp.composer && rp.composer.readBuffer;
    const gl = rp.renderer.getContext();
    const canvas = rp.renderer.domElement;
    const armed = rp.composer.passes
      .filter((p) => p.enabled !== false)
      .map((p) => Object.keys(rp._passes).find((k) => rp._passes[k] === p) || p.constructor.name);
    const env = KB.environment || KB.stage || null;
    return {
      tier: rp.quality,
      tierScale: rp.tier ? rp.tier.renderScale : null,
      scale: +rp.renderScale.toFixed(4),
      buffer: b ? Math.round(b.width) + 'x' + Math.round(b.height) : null,
      canvasCss: canvas.clientWidth + 'x' + canvas.clientHeight,
      drawingBuffer: gl.drawingBufferWidth + 'x' + gl.drawingBufferHeight,
      dpr: window.devicePixelRatio,
      adaptive: rp.effects.adaptiveResolution,
      armed,
      armedCount: armed.length,
      effectFlags: Object.fromEntries(Object.entries(rp.effects).map(([k, v]) => [k, v])),
      shadowType: rp.renderer.shadowMap.type,
      shadowEnabled: rp.renderer.shadowMap.enabled,
      phase: KB.phase,
      hp: KB.fighters.map((f) => Math.round(f.health)),
      drawCalls: rp.stats.drawCalls,
      triangles: rp.stats.triangles,
      sceneDrawCalls: rp.stats.sceneDrawCalls,
      sceneTriangles: rp.stats.sceneTriangles,
      programs: rp.stats.programs,
      midground: env && env.midground ? {
        present: true,
        children: env.midground.children.length,
        visible: env.midground.visible,
        tris: env.midgroundTris,
      } : { present: false },
    };
  };

  /* ---------------------------------------------------------- tail probe */

  /**
   * THE TAIL, NOT THE MEAN COST. p50 is already inside budget; the constraint
   * is missed entirely in the upper tail, and a pass that costs a constant X ms
   * moves p50 and p95 together, so per-pass ablation cannot explain a tail.
   *
   * This records, per frame, the things that only happen SOMETIMES: shader
   * program count (a mid-fight compile stalls the driver), draw calls, and JS
   * heap (a GC pause looks exactly like this). Late frames are then attributed
   * by coincidence rather than by ablation.
   */
  P.tail = (ms, discardMs) => new Promise((res) => {
    const rows = [];
    let last = performance.now();
    let t0 = null;
    const mem = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
    const tick = (now) => {
      const dt = now - last; last = now;
      if (t0 === null) { t0 = now; requestAnimationFrame(tick); return; }
      const el = now - t0;
      if (el >= (discardMs || 0)) {
        rows.push({
          dt: +dt.toFixed(3),
          pr: rp.stats.programs,
          fv: rp.stats.flashVariantPrograms,
          dc: rp.stats.drawCalls,
          tri: rp.stats.triangles,
          heap: mem(),
        });
      }
      if (el < (discardMs || 0) + ms) requestAnimationFrame(tick);
      else res({ rows, wall: el - (discardMs || 0), state: P.state() });
    };
    requestAnimationFrame(tick);
  });

  /* ------------------------------------------------------------ sampling */

  /**
   * Times a window of real frames. Returns the raw rAF intervals only; every
   * derived statistic is computed driver-side so the same code produces the
   * raw, pair and slide-12 columns.
   */
  P.sample = (ms, discardMs) => new Promise((res) => {
    const dts = [];
    let last = performance.now();
    let t0 = null;
    const tick = (now) => {
      const dt = now - last; last = now;
      if (t0 === null) { t0 = now; requestAnimationFrame(tick); return; }
      const el = now - t0;
      if (el >= (discardMs || 0)) dts.push(dt);
      if (el < (discardMs || 0) + ms) requestAnimationFrame(tick);
      else res({ dts, wall: el - (discardMs || 0), state: P.state() });
    };
    requestAnimationFrame(tick);
  });

  /* ------------------------------------------------------------ ablation */

  /**
   * THE CONFIG HAZARD, guarded. setEffect() is the only path that rebuilds the
   * composer; this never touches rp.effects directly. Returns the armed list so
   * the caller can assert the arm actually took.
   */
  P.setEffect = (name, on) => { rp.setEffect(name, !!on); return P.state().armed; };

  P.allOn = () => {
    for (const k of ['ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa']) rp.setEffect(k, true);
    return P.state().armed;
  };

  P.setScale = (s) => {
    rp.effects.adaptiveResolution = false;
    rp.renderScale = s;
    rp._targetScale = s;
    rp.resize();
    return P.state();
  };

  /** Midground clutter is a scene ADD made during the same round as the cuts. */
  P.setMidground = (on) => {
    const env = KB.environment || KB.stage;
    if (!env || !env.midground) return null;
    env.midground.visible = !!on;
    return P.state().midground;
  };

  /**
   * FREEZE: stop the sim and park the camera, keeping the SAME armed chain at
   * the SAME resolution. Every pass still runs on every frame; the only thing
   * removed is variation in what is on screen.
   *
   * This separates the two candidate explanations for a tail that no per-pass
   * ablation touches: either the renderer/driver has an intrinsic 1.5x spread
   * on an identical workload, or the spread is the fight -- camera cuts,
   * fighters closing, FX bursts -- making some frames genuinely more expensive.
   */
  P.setFreeze = (on) => {
    KB.paused = !!on;
    if (on) {
      if (!P._camSnap) {
        const c = rp.camera || KB.camera;
        P._camSnap = { pos: c.position.clone(), quat: c.quaternion.clone(), fov: c.fov, cam: c };
        const origRender = rp.render.bind(rp);
        P._unfreeze = () => { rp.render = origRender; };
        rp.render = (scene, cam, dt) => {
          const s = P._camSnap;
          if (s && P._frozen) {
            s.cam.position.copy(s.pos); s.cam.quaternion.copy(s.quat);
            if (s.cam.fov !== s.fov) { s.cam.fov = s.fov; s.cam.updateProjectionMatrix(); }
            s.cam.updateMatrixWorld(true);
          }
          origRender(scene, cam, dt);
        };
      }
      P._frozen = true;
    } else {
      P._frozen = false;
    }
    return { paused: KB.paused, frozen: !!P._frozen };
  };

  /** Whole shadow system, for a positive control with a known prior. */
  P.setShadows = (on) => { rp.renderer.shadowMap.enabled = !!on; return rp.renderer.shadowMap.enabled; };

  /**
   * OverlayPass is installed by EffectsDirector, NOT by RenderPipeline, so it is
   * absent from rp._passes and from every chain listing this round produced. It
   * is a fullscreen pass that runs every frame. Toggled by .enabled because
   * there is no setEffect() for it -- it is not in rp.effects at all.
   */
  P.setOverlay = (on) => {
    const p = rp.composer.passes.find((x) => x.constructor.name === 'OverlayPass');
    if (!p) return null;
    p.enabled = !!on;
    return { found: true, enabled: p.enabled };
  };

  return P.state();
})();
