/**
 * Drawer: a filing drawer with six dividers and nothing filed behind them.
 * The pointer picks a divider: it stands up and lifts, the ones behind lean
 * away and the ones in front lean in, staggered outwards from it. Each divider
 * has its tab in one of three places and a single punch; at rest the front
 * divider's punch is the bright mark, and the divider picked takes it over.
 * The read-out counts what the slot holds: none. The slider is the stagger.
 */
const {
  Cam, clamp, facing, fillet, fit, hull, open, poly, proj, rad, ringAt, rrect, run,
  tdone, tset, tval, tween, disposer, mk, place, pointer, reflect, register,
} = HL;

const N = 6, W = 80, H = 44, G = 17, TW = 22, TH = 7, TABS = [5, 29, 53], TK = 1.3;
const REST = -12, RESTS = [-15, -10, -14, -9, -13, -11], BACK = -24, FWD = 20, LIFT = 12;
const X0 = -5, X1 = W + 5, Y0 = -9, Y1 = (N - 1) * G + 9, WH = 20, WR = 6, WT = 2.4;

/** A run of points ordered left to right on screen. */
const LR = (pts) => (pts[0][0] <= pts[pts.length - 1][0] ? pts : pts.slice().reverse());

/** The drawer, which never moves: `far` is painted before the dividers, `near` after them; each entry is [d, class]. */
function drawer(P, front, outer, inner) {
  const far = [
    [poly(hull(ringAt(P, outer, 0).concat(ringAt(P, outer, WH)))), "sil"],
    [poly(ringAt(P, inner, WH)), "nf"],
    [open(ringAt(P, run(inner, (q) => !front(q)), 2.5)), "nf lo"],
  ];
  const iF = LR(ringAt(P, run(inner, front), WH)), oT = LR(ringAt(P, run(outer, front), WH)), oB = LR(ringAt(P, run(outer, front), 0));
  const hx = (X0 + X1) / 2, onFront = (ring) => ring.map((q) => P(q.u, Y1, q.v));
  const near = [
    [poly([...iF, oT[oT.length - 1], ...oB.slice().reverse(), oT[0]]), "fo"],
    [open(oT), "nf lo"],
    [open(iF), "nf"],
    [open([oT[0], ...oB, oT[oT.length - 1]]), "nf sil"],
    [poly(onFront(rrect(hx - 11, 6.5, hx + 11, 12.5, 3, 5))), "nf"],
    [poly(onFront(rrect(hx - 9.4, 8, hx + 9.4, 11, 1.5, 5))), "nf lo"],
  ];
  return { far, near };
}

/** Divider i, back to front: which of three tab positions it takes, and its filleted outline upright in its own plane. */
function divider(i) {
  const t0 = TABS[(N - 1 - i) % 3];
  const shape = fillet(
    [[0, 0], [W, 0], [W, H], [t0 + TW, H], [t0 + TW, H + TH], [t0, H + TH], [t0, H], [0, H]],
    [1, 1, 3.2, 1.8, 2.4, 2.4, 1.8, 3.2],
  );
  return { t0, shape };
}

/** Divider i leaning th degrees (negative leans back) and lifted by `lift`: its two outlines and the punch on its tab. */
function pose(P, i, t0, shape, th, lift) {
  const yb = i * G, s = Math.sin(rad(th)), c = Math.cos(rad(th));
  const w = (u, v) => P(u, yb + v * s, v * c + lift);
  const wb = (u, v) => P(u, yb + v * s - TK * c, v * c + TK * s + lift);
  return {
    back: poly(shape.map((p) => wb(p[0], p[1]))),
    face: poly(shape.map((p) => w(p[0], p[1]))),
    punch: w(t0 + TW / 2, H + TH / 2),
  };
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let stag = value;

  // Fitted to the drawer with a divider lifted, so nothing leaves the frame in any pose.
  const C = Cam(45, 0.5, 1.7);
  fit(C, [[X0, Y0, 0], [X1, Y1, -8], [X1, Y0, 0], [X0, Y1, 0], [X0, Y0, H + TH], [X1, Y0, H + TH + LIFT]], 200, 166);
  const P = proj(C), front = facing(C);
  const outer = rrect(X0, Y0, X1, Y1, WR, 6), inner = rrect(X0 + WT, Y0 + WT, X1 - WT, Y1 - WT, WR - WT, 6);
  const paths = drawer(P, front, outer, inner);

  const g = mk("g", {}, svg);
  reflect(svg, g, P, front, outer, 0, 14);
  for (const [d, cls] of paths.far) mk("path", { d, class: cls }, g);

  const items = [];
  for (let i = 0; i < N; i++) {
    const { t0, shape } = divider(i);
    const grp = mk("g", {}, g);
    const back = mk("path", { class: "lo" }, grp), face = mk("path", { class: "sil" }, grp);
    const punch = mk("circle", { r: 1.5, class: "dot " + (i === N - 1 ? "" : "off") }, grp);
    items.push({ t0, shape, back, face, punch, a: tween(RESTS[i]), z: tween(0) });
  }

  for (const [d, cls] of paths.near) mk("path", { d, class: cls }, g);

  // hit bands: oblique strips along the RESTING top edges. They never move, and nothing draws them.
  const top = (i) => P(W / 2, i * G + H * Math.sin(rad(REST)), H * Math.cos(rad(REST)));
  const c0 = top(0), c1 = top(1), d = [c1[0] - c0[0], c1[1] - c0[1]];
  const px0 = P(0, 0, 0), px1 = P(1, 0, 0), ex = [px1[0] - px0[0], px1[1] - px0[1]];
  const HALF = W / 2 + 6, det = d[0] * ex[1] - d[1] * ex[0];

  /** The divider whose band holds the point; -1 outside. */
  function hit([x, y]) {
    const qx = x - c0[0], qy = y - c0[1];
    const s = (qx * ex[1] - qy * ex[0]) / det, r = (d[0] * qy - d[1] * qx) / det;
    if (Math.abs(r) > HALF || s < -0.5 || s > N + 1) return -1;
    return clamp(Math.round(s), 0, N - 1);
  }

  function draw(i, th, lift) {
    const it = items[i], q = pose(P, i, it.t0, it.shape, th, lift);
    it.back.setAttribute("d", q.back);
    it.face.setAttribute("d", q.face);
    place(it.punch, q.punch);
  }

  const B = register(stage, (_dt, now) => {
    let moving = false;
    items.forEach((it, i) => { draw(i, tval(it.a, now), tval(it.z, now)); if (!tdone(it.a, now) || !tdone(it.z, now)) moving = true; });
    return moving;
  });
  bag.add(B.unregister);

  let act = -1;
  /** Picks divider a (-1 puts them all back). The stagger spreads out from the one picked, or the one let go. */
  function setActive(a) {
    if (a === act) return;
    const now = performance.now(), from = a >= 0 ? a : act;
    act = a;
    items.forEach((it, i) => {
      const delay = Math.abs(i - from) * stag;
      const th = a < 0 ? RESTS[i] : i < a ? BACK : i > a ? FWD : 0;
      tset(it.a, th, now, delay); tset(it.z, a === i ? LIFT : 0, now, delay);
      it.face.classList.toggle("hi", i === a);
      // the front punch is the rest mark; it gives the bright up to the divider picked
      it.punch.classList.toggle("off", a < 0 ? i !== N - 1 : i !== a);
    });
    read.textContent = a < 0 ? "rest" : `slot ${N - a} · 0`;
    B.wake();
  }

  bag.add(pointer(stage, { move: (p) => setActive(hit(p)), leave: () => setActive(-1) }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { stag = v; },
    destroy: bag.dispose,
  };
}

hairline({
  name: "drawer",
  means: "A filing drawer with six dividers and nothing filed: the one picked stands up over an empty slot.",
  rules: [1, 2, 5, 8],
  range: [0, 40, 90],
  tour: [[150, 190], [230, 150], null],
  mount,
});
