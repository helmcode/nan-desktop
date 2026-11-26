// R-V1 (round 25): the video layout check, ONE implementation shared by
//
// - the app: the core appends this file, plus a `run(config)` call, to a
//   project's preview assembled at one aspect (`video_layout_probe`); the
//   renderer loads it in a hidden, sandboxed frame sized to the canvas and
//   receives the findings by postMessage (src/video/layoutCheck.ts);
// - CI: test/template-layout-check.mjs evaluates it in headless Chrome on
//   every bundled template, in every aspect;
// - the unit tests (src/video/layoutProbe.test.ts) on its pure parts.
//
// A classic script (no module syntax): it defines `globalThis.__nanLayoutProbe`
// and does nothing else until called. It must never contain the sequence
// that closes a script element (the core inlines it). Deterministic: it
// seeks the HyperFrames runtime (`window.__player`) to fixed times and reads
// real layout; nothing depends on the wall clock but its own deadline.
//
// What counts as broken, measured on every visible text run and image:
// - "clipped": at any sample time, an element partly in frame touches the
//   edge (within MARGIN of the short side): text or an image cut off;
// - "offframe": when a scene has settled (just before it ends), something
//   visible is entirely outside the frame (mid-scene that is an entrance or
//   exit animation and is allowed).
// Elements hidden by opacity, display, visibility or an overflow-clipping
// ancestor smaller than the frame are ignored.
(function (root) {
  "use strict";

  var MARGIN = 0.02;
  /// Sample points inside a scene (fractions of its duration).
  var FRACTIONS = [0.25, 0.5, 0.75];
  /// How long before a scene ends it counts as settled (seconds).
  var SETTLE_S = 0.15;
  /// Most samples per check (a long video is sampled more sparsely).
  var MAX_SAMPLES = 48;
  /// Most findings reported per check.
  var MAX_ISSUES = 40;

  function clampTime(t, total) {
    return Math.min(Math.max(0, t), Math.max(0, total - 0.05));
  }

  /// The times to look at: per scene, three moments plus the settled end.
  /// `scenes`: [{id, start, duration}] in film seconds. Long videos keep the
  /// middle and the settled end only, then are capped at `max`.
  function samplePlan(scenes, total, max) {
    var cap = max || MAX_SAMPLES;
    var fractions = scenes.length * (FRACTIONS.length + 1) > cap ? [0.5] : FRACTIONS;
    var out = [];
    for (var i = 0; i < scenes.length; i++) {
      var s = scenes[i];
      if (!(s.duration > 0)) continue;
      for (var j = 0; j < fractions.length; j++) {
        out.push({ scene: s.id, t: clampTime(s.start + s.duration * fractions[j], total), settled: false });
      }
      out.push({ scene: s.id, t: clampTime(s.start + s.duration - SETTLE_S, total), settled: true });
    }
    if (out.length <= cap) return out;
    // Keep every settled sample first (they find the most), then fill.
    var settled = out.filter(function (p) {
      return p.settled;
    });
    if (settled.length >= cap) return settled.slice(0, cap);
    var rest = out.filter(function (p) {
      return !p.settled;
    });
    var kept = settled.concat(rest.slice(0, cap - settled.length));
    return kept.sort(function (a, b) {
      return a.t - b.t;
    });
  }

  /// What is wrong with one visible box in a W x H frame, or null.
  function classify(box, W, H, margin, settled) {
    if (box.right - box.left < 1 || box.bottom - box.top < 1) return null;
    var edge = (margin == null ? MARGIN : margin) * Math.min(W, H);
    var inFrame = box.right > 0 && box.bottom > 0 && box.left < W && box.top < H;
    var room = Math.min(box.left, box.top, W - box.right, H - box.bottom);
    if (inFrame && room < edge) return "clipped";
    if (!inFrame && settled) return "offframe";
    return null;
  }

  /// A short, readable name for an element: `#id`, `.class` or the tag,
  /// plus the start of its text.
  function hint(el) {
    var name = el.id ? "#" + el.id : el.classList && el.classList.length ? "." + el.classList[0] : el.tagName.toLowerCase();
    var text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return text ? name + ' "' + text + '"' : name;
  }

  /// Every visible text run and image, with its box clipped by any smaller
  /// overflow-clipping ancestor. Reads the live layout of `doc`.
  function collect(doc, W, H) {
    var win = doc.defaultView;
    var coversFrame = function (r) {
      return r.left <= 1 && r.top <= 1 && r.right >= W - 1 && r.bottom >= H - 1;
    };
    var opacity = function (el) {
      var o = 1;
      for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
        var cs = win.getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden") return 0;
        o *= Number(cs.opacity);
      }
      return o;
    };
    var out = [];
    var all = doc.querySelectorAll("body *");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest("script,style,template")) continue;
      var isImage = el.tagName === "IMG";
      var hasText = false;
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 && n.textContent.trim()) {
          hasText = true;
          break;
        }
      }
      if (!isImage && !hasText) continue;
      if (opacity(el) < 0.05) continue;
      var r;
      if (isImage) r = el.getBoundingClientRect();
      else {
        var range = doc.createRange();
        range.selectNodeContents(el);
        r = range.getBoundingClientRect();
      }
      var box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      for (var a = el.parentElement; a && a !== doc.body; a = a.parentElement) {
        var acs = win.getComputedStyle(a);
        if (acs.overflowX === "visible" && acs.overflowY === "visible") continue;
        var c = a.getBoundingClientRect();
        if (coversFrame(c)) continue;
        box = {
          left: Math.max(box.left, c.left),
          top: Math.max(box.top, c.top),
          right: Math.min(box.right, c.right),
          bottom: Math.min(box.bottom, c.bottom),
        };
      }
      out.push({ element: hint(el), box: box });
    }
    return out;
  }

  /// Two frames for the runtime to apply a seek, with a timer fallback (a
  /// hidden frame may not get animation frames).
  function settle(win) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () {
        if (!done) {
          done = true;
          resolve();
        }
      };
      setTimeout(finish, 80);
      try {
        win.requestAnimationFrame(function () {
          win.requestAnimationFrame(finish);
        });
      } catch (e) {
        finish();
      }
    });
  }

  /// The findings at one sample: [{scene, time, kind, element, box}].
  function checkAt(win, sample, margin) {
    var player = win.__player;
    player.pause();
    player.seek(sample.t);
    return settle(win).then(function () {
      var W = win.innerWidth;
      var H = win.innerHeight;
      var found = [];
      var boxes = collect(win.document, W, H);
      for (var i = 0; i < boxes.length; i++) {
        var kind = classify(boxes[i].box, W, H, margin, sample.settled);
        if (!kind) continue;
        var b = boxes[i].box;
        found.push({
          scene: sample.scene,
          time: Math.round(sample.t * 100) / 100,
          kind: kind,
          element: boxes[i].element,
          box: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)],
        });
      }
      return found;
    });
  }

  /// Wait (polling, bounded) for the runtime and the fonts.
  function ready(win, deadline) {
    return new Promise(function (resolve, reject) {
      var poll = function () {
        if (win.__playerReady === true && win.__player && win.document.readyState === "complete") {
          var fonts = win.document.fonts && win.document.fonts.ready ? win.document.fonts.ready : Promise.resolve();
          var left = Math.max(0, deadline - Date.now());
          Promise.race([
            fonts,
            new Promise(function (r) {
              setTimeout(r, Math.min(left, 3000));
            }),
          ]).then(function () {
            resolve();
          });
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("runtime_not_ready"));
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  }

  /// The whole check in `win`: { issues, complete }. Duplicates (the same
  /// element, same kind, same scene) are reported once, at their first time.
  /// `complete` is false when the deadline cut the sampling short.
  function checkAll(win, config) {
    var margin = config.margin == null ? MARGIN : config.margin;
    var deadline = Date.now() + (config.budgetMs || 8000);
    return ready(win, deadline).then(function () {
      var total = typeof win.__player.getDuration === "function" ? win.__player.getDuration() : config.total;
      var plan = samplePlan(config.scenes, total || config.total, config.maxSamples);
      var issues = [];
      var seen = {};
      var i = 0;
      var step = function () {
        if (i >= plan.length) return { issues: issues, complete: true };
        if (Date.now() > deadline) return { issues: issues, complete: false };
        var sample = plan[i++];
        return checkAt(win, sample, margin).then(function (found) {
          for (var k = 0; k < found.length && issues.length < MAX_ISSUES; k++) {
            var f = found[k];
            var key = f.scene + "\u0000" + f.kind + "\u0000" + f.element;
            if (seen[key]) continue;
            seen[key] = true;
            issues.push(f);
          }
          return step();
        });
      };
      return step();
    });
  }

  /// In the app's probe document: check, then post the result to the
  /// frame's parent. Never throws; a failure is reported as `error`.
  function run(config) {
    var post = function (payload) {
      try {
        root.parent.postMessage(Object.assign({ type: "nan-layout-probe" }, payload), "*");
      } catch (e) {
        /* no parent: nothing to tell */
      }
    };
    checkAll(root, config).then(
      function (result) {
        post({ issues: result.issues, complete: result.complete });
      },
      function (err) {
        post({ error: String((err && err.message) || err).slice(0, 80) });
      },
    );
  }

  root.__nanLayoutProbe = {
    MARGIN: MARGIN,
    MAX_SAMPLES: MAX_SAMPLES,
    MAX_ISSUES: MAX_ISSUES,
    samplePlan: samplePlan,
    classify: classify,
    hint: hint,
    collect: collect,
    checkAt: checkAt,
    checkAll: checkAll,
    run: run,
  };
})(typeof window !== "undefined" ? window : globalThis);
