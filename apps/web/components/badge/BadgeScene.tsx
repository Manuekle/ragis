"use client";

// The hanging badge: a card on a lanyard you can grab and throw, after Vercel's Ship '24 badge
// (vercel.com/blog/building-an-interactive-3d-event-badge-with-react-three-fiber). The strap is
// a chain of four physics bodies held by rope joints, drawn as one ribbon through them; the
// card hangs from the last one. The card, its clip and the strap are built here rather than
// loaded from a model file, and the card's faces are the canvases from ./draw.ts, so every badge
// looks like its owner.
//
// The canvas fills a layer that starts at the very top of the page and lets every click through
// (pointer-events: none); the scene listens on <body> and only reacts when the pointer is on the
// card. The layout is given in pixels of that layer: where the strap is tied, where the card
// rests and how tall it is. The camera and the strap's length are worked out from those, so the
// card lands exactly where the page left room for it, at exactly that size.

import { Environment, Lightformer, RoundedBox } from "@react-three/drei";
import { Canvas, type RootState, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { BallCollider, CuboidCollider, Physics, RigidBody, type RigidBodyProps, type RapierRigidBody, useRopeJoint, useSphericalJoint } from "@react-three/rapier";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { BAND_PX, CARD_PX, CARD_RADIUS_PX } from "./draw";

export type BadgeCanvases = { front: HTMLCanvasElement; back: HTMLCanvasElement; band: HTMLCanvasElement };
export type BadgeVersions = { front: number; back: number; band: number };

/** Where the badge goes, in CSS pixels of the layer the canvas fills. */
export type BadgeLayout = {
  /** Size of the layer. */
  width: number;
  height: number;
  /** The strap is tied above the layer's top edge at this distance from its left edge. */
  x: number;
  /** The middle of the card rests this far below the layer's top edge. */
  y: number;
  /** Height of the card. */
  card: number;
};

export type SceneProps = {
  canvases: BadgeCanvases;
  /** Bumped each time the matching canvas is redrawn. */
  versions: BadgeVersions;
  layout: BadgeLayout;
  /** Color of the card's edge (it follows the light or dark look of the faces). */
  rim: string;
  /** How dark the soft shadow behind the card is, 0–1: stronger on the dark page, where it has less to darken. */
  shade: number;
  /** Founding partners get a foil finish. */
  foil: boolean;
  /** Reduced motion: the card starts hanging still instead of dropping in with a swing. */
  calm: boolean;
  /** False while the badge is out of view: rendering and physics pause. */
  active: boolean;
  /** Called once the first frame with the badge in it has been drawn. */
  onReady?: () => void;
};

const FOV = 25;
/** Card size in scene units: the proportions of the texture, 1.6 wide. */
const CARD = { w: 1.6, h: (1.6 * CARD_PX.h) / CARD_PX.w, depth: 0.03, radius: (1.6 * CARD_RADIUS_PX) / CARD_PX.w };
/** From the middle of the card up to where the strap ends, inside the clip. */
const HOOK = 1.39;
const STRAP = { width: 0.3, segments: 36 };
/** One repeat of the lanyard texture, in scene units along the strap. */
const STRAP_TILE = (STRAP.width * BAND_PX.w) / BAND_PX.h;

/** Pointer position from the canvas' place on screen, so events can come from <body>. */
function compute(event: PointerEvent | MouseEvent | WheelEvent, state: RootState) {
  const rect = state.gl.domElement.getBoundingClientRect();
  state.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  state.raycaster.setFromCamera(state.pointer, state.camera);
}

/** The layout in scene units: how far back the camera sits, where the strap is tied, how long each of its three links is. */
function measure(layout: BadgeLayout) {
  const perUnit = layout.card / CARD.h;
  const viewH = layout.height / perUnit;
  const top = viewH / 2;
  // Tied a little above the top edge, so the strap leaves the page instead of ending on it.
  const anchor: V3 = [(layout.x - layout.width / 2) / perUnit, top + 0.35, 0];
  const rest = top - layout.y / perUnit;
  return { distance: viewH / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2))), anchor, link: Math.max(0.2, (anchor[1] - rest - HOOK) / 3) };
}

export default function BadgeScene({ canvases, versions, layout, rim, shade, foil, calm, active, onReady }: SceneProps) {
  const scene = useMemo(() => measure(layout), [layout]);
  return (
    <Canvas
      camera={{ position: [0, 0, scene.distance], fov: FOV, near: 0.1, far: scene.distance + 50 }}
      dpr={[1, 2]}
      // No tone mapping: the card shows the app's exact colors, not filmic, washed-out ones.
      flat
      gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
      frameloop={active ? "always" : "never"}
      eventSource={document.body}
      onCreated={(state) => state.setEvents({ compute })}
    >
      <CameraRig distance={scene.distance} />
      <Physics interpolate gravity={[0, -40, 0]} timeStep={1 / 60} paused={!active}>
        {/* A new layout hangs a new badge: the joints' lengths can't change once made. */}
        <Lanyard key={`${layout.width}:${layout.height}:${layout.x}:${layout.y}:${layout.card}`} canvases={canvases} versions={versions} anchor={scene.anchor} link={scene.link} rim={rim} shade={shade} foil={foil} calm={calm} onReady={onReady} />
      </Physics>
      <Environment frames={1} resolution={256}>
        <Lightformer intensity={2} color="white" position={[0, -1, 5]} rotation={[0, 0, Math.PI / 3]} scale={[100, 0.1, 1]} />
        <Lightformer intensity={3} color="white" position={[-1, -1, 1]} rotation={[0, 0, Math.PI / 3]} scale={[100, 0.1, 1]} />
        <Lightformer intensity={3} color="white" position={[1, 1, 1]} rotation={[0, 0, Math.PI / 3]} scale={[100, 0.1, 1]} />
        {/* Two walls of light, one at each side and none straight ahead: the card is clean while it
            hangs still and a sheen crosses it when it turns either way. */}
        <Lightformer intensity={10} color="white" position={[-10, 0, 3]} rotation={[0, Math.PI / 2, Math.PI / 3]} scale={[22, 10, 1]} />
        <Lightformer intensity={5} color="white" position={[10, 2, 3]} rotation={[0, -Math.PI / 2, Math.PI / 3]} scale={[22, 6, 1]} />
      </Environment>
    </Canvas>
  );
}

function CameraRig({ distance }: { distance: number }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    camera.position.set(0, 0, distance);
    camera.far = distance + 50;
    camera.updateProjectionMatrix();
  }, [camera, distance]);
  return null;
}

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const x = -w / 2;
  const y = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Front face, back face and the edge between them. Face UVs span the whole card, 0–1. */
function cardGeometry() {
  const shape = roundedRect(CARD.w, CARD.h, CARD.radius);
  const face = new THREE.ShapeGeometry(shape, 16);
  const pos = face.attributes.position;
  const uv = face.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / CARD.w + 0.5, pos.getY(i) / CARD.h + 0.5);
  const edge = new THREE.ExtrudeGeometry(shape, { depth: CARD.depth, bevelEnabled: false, curveSegments: 16 });
  edge.translate(0, 0, -CARD.depth / 2);
  return { face, edge };
}

/** The strap: a flat ribbon of two rows of points, moved every frame to follow the rope. */
function strapGeometry() {
  const points = STRAP.segments + 1;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points * 6), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(points * 4), 2));
  const index: number[] = [];
  for (let i = 0; i < STRAP.segments; i++) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  g.setIndex(index);
  return g;
}

/** A soft shadow the shape of the card, with room around it for the blur. */
const SHADOW = { pad: 0.5, px: 96 };
function shadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((CARD.w + SHADOW.pad * 2) * SHADOW.px);
  canvas.height = Math.round((CARD.h + SHADOW.pad * 2) * SHADOW.px);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // The card is drawn off the canvas; only its blurred shadow lands on it.
    const away = canvas.width * 2;
    ctx.shadowColor = "#000000";
    ctx.shadowBlur = SHADOW.pad * SHADOW.px * 0.62;
    ctx.shadowOffsetX = away;
    ctx.beginPath();
    ctx.roundRect(SHADOW.pad * SHADOW.px - away, SHADOW.pad * SHADOW.px, CARD.w * SHADOW.px, CARD.h * SHADOW.px, CARD.radius * SHADOW.px);
    ctx.fill();
  }
  return new THREE.CanvasTexture(canvas);
}

function canvasTexture(canvas: HTMLCanvasElement, anisotropy: number, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  if (repeat) t.wrapS = THREE.RepeatWrapping;
  return t;
}

type Grab = THREE.Vector3 | false;
type V3 = [number, number, number];

function setCursor(value: "grab" | "grabbing" | null) {
  if (value) document.documentElement.dataset.badgeCursor = value;
  else delete document.documentElement.dataset.badgeCursor;
}

type LanyardProps = Pick<SceneProps, "canvases" | "versions" | "rim" | "shade" | "foil" | "calm" | "onReady"> & { anchor: V3; link: number; maxSpeed?: number; minSpeed?: number };

function Lanyard({ canvases, versions, anchor, link, rim, shade, foil, calm, onReady, maxSpeed = 50, minSpeed = 10 }: LanyardProps) {
  const shadow = useRef<THREE.Mesh>(null);
  const fixed = useRef<RapierRigidBody>(null!);
  const j1 = useRef<RapierRigidBody>(null!);
  const j2 = useRef<RapierRigidBody>(null!);
  const j3 = useRef<RapierRigidBody>(null!);
  const card = useRef<RapierRigidBody>(null!);
  const lerped = useRef<[THREE.Vector3 | null, THREE.Vector3 | null]>([null, null]);
  const told = useRef(false);
  const [tmp] = useState(() => ({ vec: new THREE.Vector3(), dir: new THREE.Vector3(), ang: new THREE.Vector3(), rot: new THREE.Vector3(), at: new THREE.Vector3(), p: new THREE.Vector3(), q: new THREE.Vector3(), side: new THREE.Vector2(1, 0), turn: new THREE.Quaternion(), tilt: new THREE.Euler() }));
  const [curve] = useState(() => {
    const c = new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]);
    c.curveType = "chordal";
    return c;
  });
  const [grabbed, grab] = useState<Grab>(false);
  const [hovered, hover] = useState(false);
  const anisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy());

  const geometry = useMemo(cardGeometry, []);
  const strap = useMemo(strapGeometry, []);
  const shadowMap = useMemo(shadowTexture, []);
  const textures = useMemo(() => ({ front: canvasTexture(canvases.front, anisotropy), back: canvasTexture(canvases.back, anisotropy), band: canvasTexture(canvases.band, anisotropy, true) }), [canvases, anisotropy]);
  const materials = useMemo(
    () => ({
      metal: new THREE.MeshStandardMaterial({ color: "#d6d6dc", metalness: 1, roughness: 0.24, envMapIntensity: 1.25 }),
      hidden: new THREE.MeshBasicMaterial({ visible: false }),
      edge: new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 }),
    }),
    [],
  );
  useEffect(() => void materials.edge.color.set(rim), [materials, rim]);

  // Push only the canvas that was redrawn: typing a name re-uploads the front, not all three.
  useEffect(() => void (textures.front.needsUpdate = true), [versions.front, textures]);
  useEffect(() => void (textures.back.needsUpdate = true), [versions.back, textures]);
  useEffect(() => void (textures.band.needsUpdate = true), [versions.band, textures]);

  useEffect(() => () => Object.values(textures).forEach((t) => t.dispose()), [textures]);
  useEffect(
    () => () => {
      geometry.face.dispose();
      geometry.edge.dispose();
      strap.dispose();
      shadowMap.dispose();
      Object.values(materials).forEach((m) => m.dispose());
    },
    [geometry, strap, shadowMap, materials],
  );

  useRopeJoint(fixed, j1, [[0, 0, 0], [0, 0, 0], link]);
  useRopeJoint(j1, j2, [[0, 0, 0], [0, 0, 0], link]);
  useRopeJoint(j2, j3, [[0, 0, 0], [0, 0, 0], link]);
  useSphericalJoint(j3, card, [[0, 0, 0], [0, HOOK, 0]]);

  useEffect(() => {
    setCursor(grabbed ? "grabbing" : hovered ? "grab" : null);
    document.documentElement.toggleAttribute("data-badge-grabbing", Boolean(grabbed));
  }, [hovered, grabbed]);
  useEffect(
    () => () => {
      setCursor(null);
      document.documentElement.removeAttribute("data-badge-grabbing");
    },
    [],
  );

  useFrame((state, delta) => {
    const [c, f, a, b, d] = [card.current, fixed.current, j1.current, j2.current, j3.current];
    if (!c || !f || !a || !b || !d) return;
    const { vec, dir, ang, rot, at, p, q, side, turn, tilt } = tmp;

    if (grabbed) {
      // Follow the pointer on the plane the card hangs in.
      vec.set(state.pointer.x, state.pointer.y, 0.5).unproject(state.camera);
      dir.copy(vec).sub(state.camera.position).normalize();
      vec.add(dir.multiplyScalar(state.camera.position.length()));
      [c, a, b, d, f].forEach((body) => body.wakeUp());
      c.setNextKinematicTranslation({ x: vec.x - grabbed.x, y: vec.y - grabbed.y, z: vec.z - grabbed.z });
    }

    // Ease the two middle points toward their bodies: removes most jitter when the strap is pulled hard.
    [a, b].forEach((body, i) => {
      at.copy(body.translation());
      const point = (lerped.current[i] ??= at.clone());
      const pull = Math.max(0.1, Math.min(1, point.distanceTo(at)));
      point.lerp(at, Math.min(1, delta * (minSpeed + pull * (maxSpeed - minSpeed))));
    });
    curve.points[0].copy(d.translation());
    curve.points[1].copy(lerped.current[1]!);
    curve.points[2].copy(lerped.current[0]!);
    curve.points[3].copy(f.translation());

    // Lay the ribbon along the curve, from the clip up to where it is tied. Its width runs
    // across the direction of travel as seen from the front, so it always faces the viewer.
    const pos = strap.attributes.position as THREE.BufferAttribute;
    const uv = strap.attributes.uv as THREE.BufferAttribute;
    const half = STRAP.width / 2;
    let along = 0;
    curve.getPoint(0, q);
    for (let i = 0; i <= STRAP.segments; i++) {
      curve.getPoint(i / STRAP.segments, p);
      if (i > 0) {
        const dx = p.x - q.x;
        const dy = p.y - q.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-5) side.set(dy / len, -dx / len);
        along += p.distanceTo(q);
      } else {
        curve.getPoint(1 / STRAP.segments, at);
        const len = Math.hypot(at.x - p.x, at.y - p.y);
        if (len > 1e-5) side.set((at.y - p.y) / len, -(at.x - p.x) / len);
      }
      pos.setXYZ(i * 2, p.x - side.x * half, p.y - side.y * half, p.z);
      pos.setXYZ(i * 2 + 1, p.x + side.x * half, p.y + side.y * half, p.z);
      // The words on the strap read downward, toward the card.
      uv.setXY(i * 2, -along / STRAP_TILE, 0);
      uv.setXY(i * 2 + 1, -along / STRAP_TILE, 1);
      q.copy(p);
    }
    pos.needsUpdate = true;
    uv.needsUpdate = true;

    // The shadow: as if a wall stood a little behind the card, lit from above. It follows the
    // card, leans with it, and narrows as the card turns its edge to the viewer.
    if (shadow.current) {
      at.copy(c.translation());
      tilt.setFromQuaternion(turn.copy(c.rotation()), "ZYX");
      shadow.current.position.set(at.x + 0.03, at.y - 0.11, at.z - 0.4);
      shadow.current.rotation.z = tilt.z;
      shadow.current.scale.set(Math.max(0.2, Math.abs(Math.cos(tilt.y))), Math.max(0.2, Math.abs(Math.cos(tilt.x))), 1);
    }

    // Turn the card back toward the screen after a spin.
    ang.copy(c.angvel());
    rot.copy(c.rotation());
    c.setAngvel({ x: ang.x, y: ang.y - rot.y * 0.25, z: ang.z }, true);

    if (!told.current) {
      told.current = true;
      onReady?.();
    }
  });

  const segment: RigidBodyProps = { type: "dynamic", canSleep: true, colliders: false, angularDamping: 4, linearDamping: 4 };
  // Normally the strap starts sideways, above the top of the page, and falls into place with a swing.
  const start: Record<"j1" | "j2" | "j3" | "card", V3> = calm
    ? { j1: [0, -link, 0], j2: [0, -link * 2, 0], j3: [0, -link * 3, 0], card: [0, -link * 3 - HOOK, 0] }
    : { j1: [link * 0.5, 0, 0], j2: [link, 0, 0], j3: [link * 1.5, 0, 0], card: [link * 2, 0, 0] };

  function onDown(e: ThreeEvent<PointerEvent>) {
    const body = card.current;
    if (!body) return;
    e.stopPropagation();
    (e.target as unknown as Element).setPointerCapture(e.pointerId);
    grab(new THREE.Vector3().copy(e.point).sub(tmp.at.copy(body.translation())));
  }
  function onUp(e: ThreeEvent<PointerEvent>) {
    (e.target as unknown as Element).releasePointerCapture(e.pointerId);
    grab(false);
  }

  const z = CARD.depth / 2;
  // The gloss: a clear coat that only adds the light it reflects, laid over faces that are not
  // lit at all. The print keeps the app's exact colors and still catches the light when it turns.
  // Founding partners get a foil under the coat: its reflections shift color with the angle.
  const gloss = {
    color: "#000000", roughness: 0.3, specularIntensity: foil ? 1 : 0, clearcoat: 1, clearcoatRoughness: 0.16, envMapIntensity: foil ? 0.6 : 0.2,
    iridescence: foil ? 1 : 0, iridescenceIOR: 1.3, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  };

  return (
    <>
      <group position={anchor}>
        <RigidBody ref={fixed} {...segment} type="fixed" />
        <RigidBody position={start.j1} ref={j1} {...segment}>
          <BallCollider args={[0.1]} />
        </RigidBody>
        <RigidBody position={start.j2} ref={j2} {...segment}>
          <BallCollider args={[0.1]} />
        </RigidBody>
        <RigidBody position={start.j3} ref={j3} {...segment}>
          <BallCollider args={[0.1]} />
        </RigidBody>
        <RigidBody position={start.card} ref={card} {...segment} type={grabbed ? "kinematicPosition" : "dynamic"}>
          <CuboidCollider args={[CARD.w / 2, CARD.h / 2, 0.01]} />
          <group onPointerOver={() => hover(true)} onPointerOut={() => hover(false)} onPointerDown={onDown} onPointerUp={onUp}>
            <mesh geometry={geometry.face} position={[0, 0, z + 0.0004]}>
              <meshBasicMaterial map={textures.front} toneMapped={false} />
            </mesh>
            <mesh geometry={geometry.face} position={[0, 0, z + 0.0012]}>
              <meshPhysicalMaterial {...gloss} />
            </mesh>
            <mesh geometry={geometry.face} position={[0, 0, -z - 0.0004]} rotation={[0, Math.PI, 0]}>
              <meshBasicMaterial map={textures.back} toneMapped={false} />
            </mesh>
            <mesh geometry={geometry.face} position={[0, 0, -z - 0.0012]} rotation={[0, Math.PI, 0]}>
              <meshPhysicalMaterial {...gloss} />
            </mesh>
            <mesh geometry={geometry.edge} material={[materials.hidden, materials.edge]} />
            {/* the clip, top down: a crimp closed over the end of the strap, a swivel pin, a clamp over the card's top edge */}
            <RoundedBox args={[STRAP.width + 0.05, 0.12, 0.07]} radius={0.022} smoothness={4} position={[0, HOOK - 0.035, 0]} material={materials.metal} />
            <mesh position={[0, CARD.h / 2 + 0.115, 0]} material={materials.metal}>
              <cylinderGeometry args={[0.026, 0.026, 0.11, 20]} />
            </mesh>
            <RoundedBox args={[0.44, 0.15, CARD.depth + 0.06]} radius={0.03} smoothness={4} position={[0, CARD.h / 2 - 0.015, 0]} material={materials.metal} />
          </group>
        </RigidBody>
      </group>
      <mesh ref={shadow} renderOrder={-1}>
        <planeGeometry args={[CARD.w + SHADOW.pad * 2, CARD.h + SHADOW.pad * 2]} />
        <meshBasicMaterial map={shadowMap} transparent opacity={shade} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh geometry={strap} frustumCulled={false}>
        <meshBasicMaterial map={textures.band} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
    </>
  );
}
