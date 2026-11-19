import * as THREE from "three";
import { OrbitControls } from "three/addons/OrbitControls.js";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------------------------------------------------------------- data
const story = await (await fetch("data/story.json")).json();
// elevation lives in a PNG (red = high byte, green = low byte) so any static host accepts it
const demRaw = await (async () => {
  const bmp = await createImageBitmap(await (await fetch(`data/${story.dem.file}`)).blob(),
    { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const c = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d", { willReadFrequently: true });
  c.drawImage(bmp, 0, 0);
  const px = c.getImageData(0, 0, bmp.width, bmp.height).data;
  const out = new Uint16Array(bmp.width * bmp.height);
  for (let i = 0; i < out.length; i++) out[i] = (px[i * 4] << 8) | px[i * 4 + 1];
  return out;
})();
const DEM_N = story.dem.size;
const [WEST, SOUTH, EAST, NORTH] = story.bbox;
const MID_LAT = (SOUTH + NORTH) / 2;
const W = (EAST - WEST) * 111.32 * Math.cos((MID_LAT * Math.PI) / 180); // km
const H = (NORTH - SOUTH) * 110.57;                                          // km
const EXAG = 1.3;
const MIN_E = story.dem.min;
const BASE = -1.4;

function elevAt(u, v) {            // u: 0 west → 1 east, v: 0 north → 1 south
  const x = Math.min(Math.max(u * (DEM_N - 1), 0), DEM_N - 1);
  const y = Math.min(Math.max(v * (DEM_N - 1), 0), DEM_N - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, DEM_N - 1), y1 = Math.min(y0 + 1, DEM_N - 1);
  const fx = x - x0, fy = y - y0, g = (r, c) => demRaw[r * DEM_N + c];
  return (g(y0, x0) * (1 - fx) + g(y0, x1) * fx) * (1 - fy) + (g(y1, x0) * (1 - fx) + g(y1, x1) * fx) * fy;
}
const yOf = (e) => ((e - MIN_E) / 1000) * EXAG;
function world(lon, lat, lift = 0) {
  const u = (lon - WEST) / (EAST - WEST), v = (NORTH - lat) / (NORTH - SOUTH);
  return new THREE.Vector3(u * W - W / 2, yOf(elevAt(u, v)) + lift, v * H - H / 2);
}

// ---------------------------------------------------------------- renderer, camera
const canvas = $("#scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 400);
camera.position.set(30, 44, 52);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = 1.3;
controls.minDistance = 3;
controls.maxDistance = 100;

scene.add(new THREE.HemisphereLight(0xfff1e2, 0x2a2420, 1.5));
const sun = new THREE.DirectionalLight(0xffe2c4, 1.3);
sun.position.set(30, 40, 20);
scene.add(sun);

const narrow = () => window.innerWidth <= 760;
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // keep the model in the free space: left of the story panel on desktop, above the sheet on phones
  if (narrow()) camera.setViewOffset(w, h, 0, h * 0.22, w, h);
  else camera.setViewOffset(w, h, Math.min(215, w * 0.15), 0, w, h);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------- textures
const loader = new THREE.TextureLoader();
const texCache = new Map();
function tex(path) {
  if (!texCache.has(path)) {
    const t = loader.load(`data/${path}`);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texCache.set(path, t);
  }
  return texCache.get(path);
}
const passes = story.passes;
const severityTex = tex("tex/severity.png");
// warm the cache for the first view so the intro's "ready" means ready
passes.forEach((p) => p.date === "2024-07-20" && (tex(p.tc), tex(p.ir)));

// ---------------------------------------------------------------- terrain block
const SEG = 255;
const terrainGeo = new THREE.PlaneGeometry(W, H, SEG, SEG);
terrainGeo.rotateX(-Math.PI / 2);
{
  const p = terrainGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = (p.getX(i) + W / 2) / W, v = (p.getZ(i) + H / 2) / H;
    p.setY(i, yOf(elevAt(u, v)));
  }
  terrainGeo.computeVertexNormals();
}
const first = passes.find((p) => p.date === "2024-07-20");
const terrainMat = new THREE.ShaderMaterial({
  uniforms: {
    texA: { value: tex(first.tc) }, texB: { value: tex(first.tc) }, mixAB: { value: 0 },
    overlay: { value: severityTex }, overlayAmt: { value: 0 },
    lightDir: { value: new THREE.Vector3(0.55, 0.8, 0.3).normalize() }, dim: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv; varying vec3 vN;
    void main() { vUv = uv; vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D texA, texB, overlay; uniform float mixAB, overlayAmt, dim; uniform vec3 lightDir;
    varying vec2 vUv; varying vec3 vN;
    void main() {
      vec3 c = mix(texture2D(texA, vUv).rgb, texture2D(texB, vUv).rgb, mixAB);
      float l = max(dot(normalize(vN), lightDir), 0.0);
      c *= 0.5 + 0.75 * l;
      c = mix(c, c * vec3(0.55, 0.52, 0.5), dim);           // darken the base so markers read on top
      vec4 o = texture2D(overlay, vUv);
      c = mix(c, o.rgb * (0.65 + 0.45 * l), clamp(o.a * overlayAmt, 0.0, 1.0));
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }`,
});
const terrain = new THREE.Mesh(terrainGeo, terrainMat);
scene.add(terrain);

// cut sides: dark soil and ash bands
function soilTexture() {
  const c = document.createElement("canvas");
  c.width = 8; c.height = 256;
  const g = c.getContext("2d");
  const bands = ["#3b322b", "#2f2823", "#46392f", "#2a2420", "#51443a", "#352d27", "#40362e"];
  let y = 0, i = 0;
  while (y < 256) { const h = 8 + ((i * 29) % 19); g.fillStyle = bands[i % bands.length]; g.fillRect(0, y, 8, h); y += h; i++; }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const soil = soilTexture();
const topMax = yOf(story.dem.max);
function wall(points) {
  const pos = [], uv = [], idx = [];
  points.forEach((p, i) => {
    pos.push(p.x, p.y, p.z, p.x, BASE, p.z);
    uv.push(i / 40, (p.y - BASE) / (topMax - BASE), i / 40, 0);
    if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: soil, side: THREE.DoubleSide }));
}
{
  const p = terrainGeo.attributes.position, n = SEG + 1, at = (r, c) => new THREE.Vector3(p.getX(r * n + c), p.getY(r * n + c), p.getZ(r * n + c));
  const north = [], south = [], west = [], east = [];
  for (let i = 0; i < n; i++) { north.push(at(0, i)); south.push(at(n - 1, i)); west.push(at(i, 0)); east.push(at(i, n - 1)); }
  [north, south, west, east].forEach((e) => scene.add(wall(e)));
  const bottom = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ color: 0x1d1916 }));
  bottom.rotateX(Math.PI / 2); bottom.position.y = BASE; scene.add(bottom);
}
// ember glow under the block
{
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), grd = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,122,47,0.16)"); grd.addColorStop(1, "rgba(255,122,47,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(W * 2.1, H * 2.1),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  glow.rotateX(-Math.PI / 2); glow.position.y = BASE - 1; scene.add(glow);
}

// ---------------------------------------------------------------- draped lines (perimeter, roads, rail)
function drape(coords, lift, step = 0.25) {
  const pts = [];
  for (let i = 0; i < coords.length - 1; i++) {        // densify so the line hugs the terrain
    const [a0, a1] = coords[i], [b0, b1] = coords[i + 1];
    for (let t = 0; t < 1; t += step) pts.push(world(a0 + (b0 - a0) * t, a1 + (b1 - a1) * t, lift));
  }
  const last = coords[coords.length - 1];
  pts.push(world(last[0], last[1], lift));
  return new THREE.BufferGeometry().setFromPoints(pts);
}
const perimeterGroup = new THREE.Group();
const periMat = new THREE.LineDashedMaterial({ color: 0xffd9b8, dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.9 });
for (const ring of story.perimeter) {
  const line = new THREE.Line(drape(ring, 0.06, 0.34), periMat);
  line.computeLineDistances();
  perimeterGroup.add(line);
}
perimeterGroup.visible = false;
scene.add(perimeterGroup);

const netGroup = new THREE.Group();
const roadMat = new THREE.LineBasicMaterial({ color: 0xf3ece4, transparent: true, opacity: 0.55 });
const railMat = new THREE.LineBasicMaterial({ color: 0xb9ab9c, transparent: true, opacity: 0.6 });
for (const r of story.roads) netGroup.add(new THREE.Line(drape(r.coords, 0.03), roadMat));
for (const r of story.rail) netGroup.add(new THREE.Line(drape(r.coords, 0.03), railMat));
netGroup.visible = false;
scene.add(netGroup);

// ---------------------------------------------------------------- hotspots (heat detections) replayed in time
const T0 = Date.parse(story.hotspots[0].t + ":00Z"), T1 = Date.parse(story.hotspots.at(-1).t + ":00Z");
const hsGeo = new THREE.BufferGeometry();
{
  const pos = [], tt = [], frp = [];
  for (const h of story.hotspots) {
    const p = world(h.lon, h.lat, 0.12);
    pos.push(p.x, p.y, p.z);
    tt.push((Date.parse(h.t + ":00Z") - T0) / (T1 - T0));
    frp.push(Math.min(h.frp / 80, 1));
  }
  hsGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  hsGeo.setAttribute("t", new THREE.Float32BufferAttribute(tt, 1));
  hsGeo.setAttribute("frp", new THREE.Float32BufferAttribute(frp, 1));
}
const hsMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { now: { value: 1 }, px: { value: renderer.getPixelRatio() } },
  vertexShader: `
    attribute float t; attribute float frp; uniform float now, px; varying float vAge; varying float vF;
    void main(){
      vAge = now - t; vF = frp;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float fresh = smoothstep(0.06, 0.0, vAge);
      gl_PointSize = step(0.0, vAge) * (5.0 + 9.0 * fresh + 4.0 * frp) * px * (38.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    varying float vAge; varying float vF;
    void main(){
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.0, d);
      float fresh = smoothstep(0.06, 0.0, vAge);
      vec3 c = mix(vec3(0.85, 0.22, 0.08), vec3(1.0, 0.86, 0.55), fresh);
      gl_FragColor = vec4(c, a * mix(0.45, 1.0, fresh));
    }`,
});
const hotspots = new THREE.Points(hsGeo, hsMat);
hotspots.visible = false;
hotspots.renderOrder = 3;
scene.add(hotspots);

// ---------------------------------------------------------------- places
const pinMat = new THREE.MeshBasicMaterial({ color: 0xf3ece4 });
const labelsEl = $("#labels");
const labels = [];
for (const pl of story.places) {
  const base = world(pl.lon, pl.lat);
  const h = pl.kind === "peak" ? 0.25 : 0.55;
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, h, 6), pinMat);
  stick.position.copy(base).add(new THREE.Vector3(0, h / 2, 0));
  const head = new THREE.Mesh(new THREE.SphereGeometry(pl.kind === "town" ? 0.09 : 0.06, 12, 8), pinMat);
  head.position.copy(base).add(new THREE.Vector3(0, h, 0));
  scene.add(stick, head);
  const el = document.createElement("div");
  el.className = "label" + (pl.kind ? ` ${pl.kind}` : "");
  el.innerHTML = pl.ele ? `${pl.name}<small>${pl.ele.toLocaleString()} m</small>` : pl.name;
  labelsEl.append(el);
  labels.push({ el, pos: head.position.clone().add(new THREE.Vector3(0, 0.16, 0)), ground: base.clone().add(new THREE.Vector3(0, 0.08, 0)), meshes: [stick, head], kind: pl.kind });
}

// ---------------------------------------------------------------- town buildings, coloured by distance to burned ground
const townGroup = new THREE.Group();
scene.add(townGroup);
const townB = story.buildings.filter((b) => b.town);
const bGeo = new THREE.BoxGeometry(0.035, 0.03, 0.035);
bGeo.translate(0, 0.015, 0);
const buildings = new THREE.InstancedMesh(bGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), townB.length);
const COL = { d50: new THREE.Color("#ff4d2e"), d200: new THREE.Color("#ffb35c"), far: new THREE.Color("#d8d2cc") };
const bandOf = (d) => (d <= 50 ? "d50" : d <= 200 ? "d200" : "far");
const m4 = new THREE.Matrix4();
townB.forEach((b, i) => {
  const p = world(b.lon, b.lat, 0.012);
  m4.makeTranslation(p.x, p.y, p.z);
  buildings.setMatrixAt(i, m4);
  buildings.setColorAt(i, COL[bandOf(b.dist_m)]);
});
townGroup.add(buildings);
townGroup.visible = false;

// 10 m true-colour patch over the townsite, laid just above the 42 m terrain for the close-up
const [TW, TS, TE, TN] = story.town_bbox;
const townTex = { pre: tex("tex/town_pre.jpg"), post: tex("tex/town_post.jpg") };
const patchGeo = new THREE.PlaneGeometry(1, 1, 120, 120);
{
  const p = patchGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const lon = TW + (p.getX(i) + 0.5) * (TE - TW), lat = TS + (p.getY(i) + 0.5) * (TN - TS);
    const v = world(lon, lat, 0.01);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  patchGeo.computeVertexNormals();
}
const patchMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: townTex.post }, lightDir: terrainMat.uniforms.lightDir, opacity: { value: 0 } },
  transparent: true,
  // the patch samples the elevation more finely than the terrain mesh; pull it forward so it never dips under
  polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
  vertexShader: `varying vec2 vUv; varying vec3 vN; void main(){ vUv = uv; vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D map; uniform vec3 lightDir; uniform float opacity; varying vec2 vUv; varying vec3 vN;
    void main(){
      vec3 c = texture2D(map, vUv).rgb * (0.75 + 0.4 * max(dot(normalize(vN), lightDir), 0.0));
      // feather the edges into the coarser terrain
      float e = smoothstep(0.0, 0.06, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
      gl_FragColor = vec4(c, opacity * e);
      #include <colorspace_fragment>
    }`,
});
const patch = new THREE.Mesh(patchGeo, patchMat);
patch.renderOrder = 1;
scene.add(patch);
let patchTarget = 0;

// ---------------------------------------------------------------- surface switching
let surfaceAnim = null;
function setSurface(t) {
  const u = terrainMat.uniforms;
  if (u.texA.value === t && u.mixAB.value === 0) return;
  u.texB.value = t;
  surfaceAnim = { start: performance.now(), dur: reduceMotion ? 1 : 600 };
}
let overlayTarget = 0, dimTarget = 0;

// ---------------------------------------------------------------- camera flights
const town = world(-118.078, 52.878, 0);
const VIEWS = {
  valley: { target: new THREE.Vector3(-3, 0, 3), offset: new THREE.Vector3(34, 58, 66) },
  run: { target: world(-117.985, 52.78, 0), offset: new THREE.Vector3(-26, 36, 34) },
  town: { target: town, offset: new THREE.Vector3(1.9, 2.9, 3.4) },
};
let flight = null;
function flyTo(name) {
  const v = VIEWS[name];
  const to = { pos: v.target.clone().add(v.offset.clone().multiplyScalar(narrow() ? 1.5 : 1)), target: v.target.clone() };
  if (reduceMotion) { camera.position.copy(to.pos); controls.target.copy(to.target); return; }
  flight = { from: { pos: camera.position.clone(), target: controls.target.clone() }, to, start: performance.now(), dur: 1800 };
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ---------------------------------------------------------------- hotspot replay
const clockEl = $("#clock");
const fmtClock = (ms) => new Date(ms).toLocaleString("en-CA", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
let replay = null;
function startReplay() {
  hotspots.visible = true;
  if (reduceMotion) { hsMat.uniforms.now.value = 1.2; return; }
  hsMat.uniforms.now.value = 0;
  replay = { start: performance.now(), dur: 9000 };
  clockEl.hidden = false;
}
$(".replay").addEventListener("click", startReplay);

// ---------------------------------------------------------------- view + layer state
let view = "tc";
let passIdx = passes.findIndex((p) => p.date === "2024-07-20");
let sevOn = false;
const sevToggle = $("#sev-toggle");

function apply() {
  const p = passes[passIdx];
  setSurface(tex(p[view]));
  overlayTarget = sevOn ? 0.92 : 0;
  // the sharp town patch only makes sense in natural colour without the severity layer
  patchTarget = chapter === "town" && view === "tc" && !sevOn ? 1 : 0;
  patchMat.uniforms.map.value = p.after ? townTex.post : townTex.pre;
  sevToggle.checked = sevOn;
  $$(".views button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
  $$(".stop", trackEl).forEach((t, i) => t.setAttribute("aria-checked", String(i === passIdx)));
  renderSeeing();
}
$$(".views button").forEach((b) => b.addEventListener("click", () => { view = b.dataset.view; apply(); }));
sevToggle.addEventListener("change", () => { sevOn = sevToggle.checked; apply(); });

// ---------------------------------------------------------------- timeline: passes placed on a real date axis
const trackEl = $("#track");
const DAY = 864e5;
const D0 = Date.UTC(2024, 6, 1), D1 = Date.UTC(2024, 8, 15);
const xOf = (iso) => ((Date.parse(iso + "T00:00:00Z") - D0) / (D1 - D0)) * 100;
const fmt = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
function buildTrack() {
  const fire = document.createElement("div");
  fire.className = "fire-span";
  fire.style.left = xOf("2024-07-22") + "%";
  fire.style.width = xOf("2024-09-07") - xOf("2024-07-22") + "%";
  trackEl.append(fire);
  for (const m of ["2024-07-01", "2024-08-01", "2024-09-01"]) {
    const t = document.createElement("span");
    t.className = "month"; t.style.left = xOf(m) + "%";
    t.textContent = new Date(m + "T12:00:00Z").toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
    trackEl.append(t);
  }
  passes.forEach((p, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "stop" + (p.after ? " after" : "");
    b.style.left = xOf(p.date) + "%";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", "false");
    b.setAttribute("aria-label", `${fmt(p.date)}${p.after ? ", after the fire started" : ""}`);
    b.innerHTML = `<i></i><span>${fmt(p.date)}</span>`;
    b.addEventListener("click", () => { passIdx = i; apply(); });
    trackEl.append(b);
  });
}
buildTrack();

// ---------------------------------------------------------------- "what you're seeing"
const KEY = {
  tcBefore: "Natural colour: forest dark green, rock grey-brown, snow white",
  tcAfter: "Burned forest shows as a brown-black scar",
  irVeg: "Green: living vegetation",
  irRock: "Pink and brown: bare rock and soil",
  irSnow: "Cyan: snow and ice · Black: water",
  irBurn: "Rust red: freshly burned ground",
  low: "Low severity", modlow: "Moderate-low", modhigh: "Moderate-high", high: "High severity: canopy killed",
  peri: "Dashed line: official fire perimeter",
  d50: "Building within 50 m of burned ground",
  d200: "50 to 200 m",
  far: "Further than 200 m",
  hot: "Glowing dots: heat detections, 22–24 July",
};
const SW = { tcBefore: "sw-forest", tcAfter: "sw-scar", irVeg: "sw-veg", irRock: "sw-rock", irSnow: "sw-snow", irBurn: "sw-rust",
  low: "sw-low", modlow: "sw-modlow", modhigh: "sw-modhigh", high: "sw-high", peri: "sw-peri", d50: "sw-d50", d200: "sw-d200", far: "sw-far", hot: "sw-hot" };
const legend = (...keys) => `<ul class="legend">${keys.filter(Boolean).map((k) => `<li><span class="sw ${SW[k]}"></span>${KEY[k]}</li>`).join("")}</ul>`;
const daysFromFire = (d) => Math.round((Date.parse(d + "T00:00:00Z") - Date.UTC(2024, 6, 22)) / DAY);

function renderSeeing() {
  const el = $(`#panel-${chapter} .seeing`);
  if (!el) return;
  const p = passes[passIdx], d = daysFromFire(p.date);
  const when = d < 0 ? `${-d} days before the fire` : d === 0 ? "the morning of the day the fire started" : `${d} days after it started`;
  const cloud = p.clear_pct < 90 ? ` Clouds or smoke hide part of the area in this pass.` : "";
  let html = `<p>Sentinel-2 from <strong>${fmt(p.date)}</strong>, ${when}, draped over the real terrain (heights ×${EXAG}).${cloud}</p>`;
  html += view === "tc" ? legend("tcBefore", p.after && "tcAfter") : legend("irVeg", "irRock", "irSnow", p.after && "irBurn");
  if (sevOn) html += `<p>On top: burn severity, from comparing the forest before and after the fire.</p>` + legend("low", "modlow", "modhigh", "high");
  if (chapter === "run") html += legend("peri", hotspots.visible && "hot");
  if (chapter === "town") html += `<p>${patch.visible || patchTarget ? "The townsite itself is shown at full 10&nbsp;m detail. " : ""}Each block is a mapped building. Hover one for its distance.</p>` + legend("d50", "d200", "far");
  el.innerHTML = `<h2>What you're seeing</h2>${html}`;
}

// ---------------------------------------------------------------- area chart
function drawChart() {
  const svg = $("#area-chart"), w = svg.clientWidth || 340, h = 150, pad = { l: 34, r: 10, t: 12, b: 22 };
  const nbac = story.perimeter_ha / 100, max = Math.ceil(Math.max(nbac, ...passes.map((p) => p.burned_km2)) / 100) * 100;
  const x = (iso) => pad.l + (xOf(iso) / 100) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const pts = passes.map((p) => `${x(p.date)},${y(p.burned_km2)}`).join(" ");
  svg.innerHTML = `
    <rect class="fire" x="${x("2024-07-22")}" y="${pad.t}" width="${x("2024-09-07") - x("2024-07-22")}" height="${h - pad.t - pad.b}"/>
    <line class="axis" x1="${pad.l}" x2="${w - pad.r}" y1="${y(0)}" y2="${y(0)}"/>
    <line class="ref" x1="${pad.l}" x2="${w - pad.r}" y1="${y(nbac)}" y2="${y(nbac)}"/>
    ${[0, max / 2, max].map((v) => `<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("")}
    <polyline class="line" points="${pts}"/>
    ${passes.map((p) => `<circle class="dot${p.after ? " after" : ""}" cx="${x(p.date)}" cy="${y(p.burned_km2)}" r="4"><title>${fmt(p.date)}: ${p.burned_km2} km²${p.clear_pct < 90 ? ` (${p.clear_pct}% clear)` : ""}</title></circle>`).join("")}
    <text x="${x("2024-07-01")}" y="${h - 4}">1 Jul</text>
    <text x="${x("2024-09-15")}" y="${h - 4}" text-anchor="end">15 Sep</text>`;
}

// ---------------------------------------------------------------- chapters
let chapter = null;
const CHAPTER_DEFAULTS = {
  valley: { pass: "2024-07-20", sev: false },
  run: { pass: "2024-08-19", sev: true },
  town: { pass: "2024-09-05", sev: false },
};
function setChapter(name) {
  if (!VIEWS[name]) name = "valley";
  if (name === chapter) return;
  chapter = name;
  $$(".chapters a").forEach((a) => (a.dataset.chapter === name ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  $$(".panel").forEach((p) => (p.hidden = p.dataset.chapter !== name));
  const d = CHAPTER_DEFAULTS[name];
  passIdx = passes.findIndex((p) => p.date === d.pass);
  sevOn = d.sev;
  perimeterGroup.visible = name === "run";
  netGroup.visible = name === "town";
  townGroup.visible = name === "town";
  dimTarget = name === "town" ? 0.2 : 0;
  hotspots.visible = false; replay = null; clockEl.hidden = true;
  // up close only the town-level places get labels, and the pins (sized for the overview) are hidden
  labels.forEach((l) => {
    const on = name === "town" ? l.kind === "town" || l.kind === "local" : l.kind !== "local";
    l.hidden = !on;
    l.meshes.forEach((m) => (m.visible = on && name !== "town"));
  });
  if (name === "run") { drawChart(); setTimeout(() => chapter === "run" && startReplay(), reduceMotion ? 0 : 1500); }
  apply();
  flyTo(name);
  $(`#panel-${name}`).scrollTop = 0;
}
window.addEventListener("hashchange", () => setChapter(location.hash.slice(1)));

// stats
{
  $('[data-stat="burned"]').textContent = story.burned_km2;
  $('[data-stat="nbac"]').textContent = Math.round(story.perimeter_ha / 100);
  const s = story.severity_km2, tot = Object.values(s).reduce((a, b) => a + b, 0);
  $('[data-stat="high"]').textContent = Math.round((100 * s.high) / tot);
  $('[data-stat="town"]').textContent = townB.length.toLocaleString();
  $('[data-stat="d50"]').textContent = townB.filter((b) => b.dist_m <= 50).length;
  $('[data-stat="d200"]').textContent = townB.filter((b) => b.dist_m <= 200).length;
}

// sources
$("#source-list").replaceChildren(...story.sources.map((s) => { const li = document.createElement("li"); const a = document.createElement("a"); a.href = s.url; a.textContent = s.label; a.target = "_blank"; a.rel = "noopener"; li.append(a); return li; }));
$(".sources-btn").addEventListener("click", () => $("#sources").showModal());

// ---------------------------------------------------------------- hover
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), tip = $("#tooltip");
let pointer = null;
canvas.addEventListener("pointermove", (e) => { pointer = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener("pointerleave", () => { pointer = null; tip.hidden = true; });
function hover() {
  if (!pointer) return;
  let text = null;
  if (townGroup.visible) {
    ndc.set((pointer.x / innerWidth) * 2 - 1, -(pointer.y / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hb = ray.intersectObject(buildings)[0];
    if (hb) {
      const b = townB[hb.instanceId];
      text = b.dist_m === 0 ? "Building on burned ground" : `Building ${b.dist_m} m from burned ground`;
    }
  }
  tip.hidden = !text;
  if (text) { tip.textContent = text; tip.style.left = pointer.x + "px"; tip.style.top = pointer.y + "px"; }
}

// ---------------------------------------------------------------- loop
const v3 = new THREE.Vector3();
let lastHover = 0, lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(now - lastFrame, 250); lastFrame = now;
  if (flight) {
    const t = Math.min(Math.max(0, (now - flight.start) / flight.dur), 1), k = ease(t);
    camera.position.lerpVectors(flight.from.pos, flight.to.pos, k);
    controls.target.lerpVectors(flight.from.target, flight.to.target, k);
    if (t >= 1) flight = null;
  }
  const u = terrainMat.uniforms;
  if (surfaceAnim) {
    const t = Math.min(Math.max(0, (now - surfaceAnim.start) / surfaceAnim.dur), 1);
    u.mixAB.value = t;
    if (t >= 1) { u.texA.value = u.texB.value; u.mixAB.value = 0; surfaceAnim = null; }
  }
  // fades run on time, not frame count, so slow devices get there just as fast
  const k = reduceMotion ? 1 : 1 - Math.exp(-dt / 220);
  u.overlayAmt.value += (overlayTarget - u.overlayAmt.value) * k;
  u.dim.value += (dimTarget - u.dim.value) * k;
  patchMat.uniforms.opacity.value += (patchTarget - patchMat.uniforms.opacity.value) * k;
  patch.visible = patchMat.uniforms.opacity.value > 0.01;
  if (replay) {
    const t = Math.min(Math.max((now - replay.start) / replay.dur, 0), 1);
    hsMat.uniforms.now.value = t;
    clockEl.textContent = fmtClock(T0 + t * (T1 - T0));
    if (t >= 1) {
      replay = null;
      hsMat.uniforms.now.value = 1.2;   // everything shown, nothing "fresh"
      setTimeout(() => { if (!replay) clockEl.hidden = true; }, 1600);
    }
  }
  controls.update();
  renderer.render(scene, camera);

  for (const l of labels) {
    if (l.hidden) { l.el.hidden = true; continue; }
    v3.copy(chapter === "town" ? l.ground : l.pos).project(camera);   // no pins up close, so pin labels to the ground
    const vis = v3.z < 1 && Math.abs(v3.x) < 1.05 && Math.abs(v3.y) < 1.05;
    l.el.hidden = !vis;
    if (vis) l.el.style.transform = `translate(-50%, -100%) translate(${(v3.x * 0.5 + 0.5) * innerWidth}px, ${(-v3.y * 0.5 + 0.5) * innerHeight}px)`;
  }
  if (now - lastHover > 60) { hover(); lastHover = now; }
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- intro
const enter = $("#enter");
const ready = () => { enter.disabled = false; enter.textContent = "Enter the valley"; };
THREE.DefaultLoadingManager.onLoad = ready;
setTimeout(ready, 4000);
enter.addEventListener("click", () => {
  $("#intro").classList.add("gone");
  setChapter(location.hash.slice(1) || "valley");
  setTimeout(() => $("#intro").remove(), 800);
});
window.addEventListener("resize", () => chapter === "run" && drawChart());
