/* ─────────────────────────────────────────────────────────────────────────────
   terrain.run — Decorative 3D scatter plot backdrop
   Requires Three.js loaded globally (via CDN script tag).
   Looks for <canvas id="bg-canvas"> — no-ops if not found.
   Uses InstancedMesh for performance (single draw call for all dots).
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const canvas = document.getElementById('bg-canvas');
  if (!canvas || typeof THREE === 'undefined') return;

  /* ── Config ─────────────────────────────────────────────────────────────── */
  const POINT_COUNT = 300;
  const SPHERE_RADIUS = 1.8;
  const MIN_DOT = 0.0023;
  const MAX_DOT = 0.009;
  const AUTO_ROTATE_SPEED = 0.0008;
  const MOUSE_INFLUENCE = 0.3;
  const MOUSE_LERP = 0.05;
  const NUM_CLUSTERS = 8;
  const LINE_OPACITY = 0.2;

  // Read cluster colors from CSS custom properties (--cluster-1 … --cluster-15)
  var styles = getComputedStyle(document.documentElement);
  var CLUSTER_COLORS = [];
  for (var ci = 1; ci <= 15; ci++) {
    var val = styles.getPropertyValue('--cluster-' + ci).trim();
    if (val) {
      CLUSTER_COLORS.push(new THREE.Color(val));
    }
  }
  // Fallback if no CSS vars found
  if (CLUSTER_COLORS.length === 0) {
    CLUSTER_COLORS = [0x6366f1, 0x7a9cc8, 0x14b8a6, 0xc8a96e, 0x8b5cf6,
      0x4a90d9, 0x6dbf8b, 0x3b82f6, 0xa07abf, 0x88b4d0,
      0x06b6d4, 0x5c9eca, 0x7dba84, 0x0ea5e9, 0x9b7ec8].map(function(h) { return new THREE.Color(h); });
  }

  /* ── Scene setup ────────────────────────────────────────────────────────── */
  const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0a);
  scene.fog = new THREE.FogExp2(0x0a0a0a, 0.14);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(1.5, 1.0, 2.5);
  camera.lookAt(0, 0, 0);

  /* ── Grid ───────────────────────────────────────────────────────────────── */
  var grid = new THREE.GridHelper(4, 20, 0x1a1a1a, 0x111111);
  grid.position.y = -1.5;
  scene.add(grid);

  /* ── Generate points data ───────────────────────────────────────────────── */
  var pointData = [];
  var clusterCentroids = [];
  for (var c = 0; c < NUM_CLUSTERS; c++) {
    clusterCentroids.push({ x: 0, y: 0, z: 0, count: 0 });
  }

  for (var i = 0; i < POINT_COUNT; i++) {
    var u = Math.random();
    var v = Math.random();
    var theta = 2 * Math.PI * u;
    var phi = Math.acos(2 * v - 1);
    var r = SPHERE_RADIUS * Math.cbrt(Math.random());

    var x = r * Math.sin(phi) * Math.cos(theta);
    var y = r * Math.sin(phi) * Math.sin(theta);
    var z = r * Math.cos(phi);

    var ci = Math.floor(((theta + Math.PI) / (2 * Math.PI)) * NUM_CLUSTERS) % NUM_CLUSTERS;
    var dotSize = MIN_DOT + Math.sqrt(Math.random()) * (MAX_DOT - MIN_DOT);

    pointData.push({ x: x, y: y, z: z, cluster: ci, size: dotSize });
    clusterCentroids[ci].x += x;
    clusterCentroids[ci].y += y;
    clusterCentroids[ci].z += z;
    clusterCentroids[ci].count++;
  }

  // Finalize centroids
  for (var c = 0; c < NUM_CLUSTERS; c++) {
    var n = clusterCentroids[c].count || 1;
    clusterCentroids[c].x /= n;
    clusterCentroids[c].y /= n;
    clusterCentroids[c].z /= n;
  }

  /* ── Blink config ──────────────────────────────────────────────────────── */
  // 6 blink groups. Each has a period (seconds per full cycle) and duty (fraction
  // of cycle spent flashing). Short duty + long period = brief flash, long pause.
  // Configurable via CSS: --blink-period-N, --blink-duty-N (N = 1..6)
  var BLINK_GROUPS = [];
  var defaultGroups = [
    { period: 3.0,  duty: 0.12 },  // slow, brief flash
    { period: 4.5,  duty: 0.10 },  // very slow, very brief
    { period: 2.2,  duty: 0.18 },  // medium
    { period: 5.5,  duty: 0.08 },  // glacial, tiny flash
    { period: 1.8,  duty: 0.15 },  // quicker
    { period: 7.0,  duty: 0.06 },  // very slow, barely there
  ];
  for (var gi = 0; gi < defaultGroups.length; gi++) {
    var n = gi + 1;
    BLINK_GROUPS.push({
      period: parseFloat(styles.getPropertyValue('--blink-period-' + n)) || defaultGroups[gi].period,
      duty:   parseFloat(styles.getPropertyValue('--blink-duty-' + n))   || defaultGroups[gi].duty,
    });
  }
  var BLINK_INTENSITY = parseFloat(styles.getPropertyValue('--blink-intensity')) || 0.3;

  /* ── Instanced dot meshes ───────────────────────────────────────────────── */
  var dotGeo = new THREE.SphereGeometry(1, 8, 6);
  var dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  var dots = new THREE.InstancedMesh(dotGeo, dotMat, POINT_COUNT);

  var dummy = new THREE.Object3D();

  // Store base colors and blink params per dot
  var baseColors = [];
  var blinkGroup = new Uint8Array(POINT_COUNT);   // 0, 1, or 2
  var blinkPhase = new Float32Array(POINT_COUNT);  // random offset per dot

  for (var i = 0; i < POINT_COUNT; i++) {
    var p = pointData[i];
    dummy.position.set(p.x, p.y, p.z);
    dummy.scale.setScalar(p.size);
    dummy.updateMatrix();
    dots.setMatrixAt(i, dummy.matrix);

    var baseCol = CLUSTER_COLORS[p.cluster % CLUSTER_COLORS.length];
    baseColors.push(baseCol.clone());
    dots.setColorAt(i, baseCol);

    blinkGroup[i] = Math.floor(Math.random() * BLINK_GROUPS.length);
    blinkPhase[i] = Math.random() * Math.PI * 2;
  }

  dots.instanceMatrix.needsUpdate = true;
  if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
  scene.add(dots);

  var white = new THREE.Color(1, 1, 1);
  var blinkTmp = new THREE.Color();
  var dotPos = new THREE.Vector3();
  var DIST_FALLOFF = 0.18;   // far dots (less dark = brighter bg overall)
  var DIST_SCALE = 0.24;     // distance multiplier
  var DIST_POWER = 1.5;      // power curve
  var FRONT_WHITE_WASH = 0.45;  // closest dots lerp toward white (flash overexposure)

  /* ── Connector lines (point → cluster centroid) ─────────────────────────── */
  var lineVerts = [];
  var lineColors = [];

  for (var i = 0; i < POINT_COUNT; i++) {
    var p = pointData[i];
    var cent = clusterCentroids[p.cluster];
    lineVerts.push(p.x, p.y, p.z, cent.x, cent.y, cent.z);

    var lc = CLUSTER_COLORS[p.cluster % CLUSTER_COLORS.length];
    lineColors.push(lc.r, lc.g, lc.b, lc.r, lc.g, lc.b);
  }

  var lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
  lineGeo.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));

  var lineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: LINE_OPACITY,
    depthWrite: false,
  });

  var lines = new THREE.LineSegments(lineGeo, lineMat);
  scene.add(lines);

  /* ── Mouse tracking ─────────────────────────────────────────────────────── */
  var mouseX = 0, mouseY = 0, targetX = 0, targetY = 0;
  var prevMouseX = 0;
  var spinVelocity = AUTO_ROTATE_SPEED;
  var SPIN_FRICTION = 0.97;       // decay per frame toward base speed
  var MOUSE_SPIN_GAIN = 0.003;    // how much mouse movement affects spin

  document.addEventListener('mousemove', function (e) {
    var newMouseX = (e.clientX / window.innerWidth) * 2 - 1;
    var dx = newMouseX - prevMouseX;
    // Add mouse horizontal velocity to spin (negative so drag-right = spin-right)
    spinVelocity += dx * MOUSE_SPIN_GAIN;
    prevMouseX = newMouseX;
    mouseX = newMouseX;
    mouseY = (e.clientY / window.innerHeight) * 2 - 1;
  });

  /* ── Animation ──────────────────────────────────────────────────────────── */
  var angle = 0;

  function animate() {
    requestAnimationFrame(animate);

    // Decay spin speed (magnitude only), preserve direction
    spinVelocity *= SPIN_FRICTION;
    // Keep a minimum spin so it never fully stops
    if (Math.abs(spinVelocity) < AUTO_ROTATE_SPEED) {
      spinVelocity = spinVelocity >= 0 ? AUTO_ROTATE_SPEED : -AUTO_ROTATE_SPEED;
    }
    angle += spinVelocity;
    var baseX = Math.sin(angle) * 2.5;
    var baseZ = Math.cos(angle) * 2.5;

    targetX += (mouseX - targetX) * MOUSE_LERP;
    targetY += (mouseY - targetY) * MOUSE_LERP;

    camera.position.x = baseX + targetX * MOUSE_INFLUENCE;
    camera.position.y = 1.0 - targetY * MOUSE_INFLUENCE * 0.5;
    camera.position.z = baseZ;
    camera.lookAt(0, 0, 0);

    // Blink: duty-cycle flash — brief bright pulse, long dark pause
    var t = performance.now() * 0.001; // seconds
    for (var i = 0; i < POINT_COUNT; i++) {
      var grp = BLINK_GROUPS[blinkGroup[i]];
      // Phase-shifted position in cycle (0..1)
      var pos = ((t + blinkPhase[i] * grp.period) % grp.period) / grp.period;
      var bright;
      if (pos < grp.duty) {
        // During flash: smooth bell curve (sin over the duty window)
        bright = Math.sin(pos / grp.duty * Math.PI) * BLINK_INTENSITY;
      } else {
        bright = 0;
      }
      blinkTmp.copy(baseColors[i]).lerp(white, bright);

      // Camera flash: front white-washed (overexposed), back recedes
      dotPos.set(pointData[i].x, pointData[i].y, pointData[i].z);
      var dist = camera.position.distanceTo(dotPos);
      var nearT = Math.max(0, 1 - dist * DIST_SCALE);
      var distFactor = DIST_FALLOFF + (1 - DIST_FALLOFF) * Math.pow(nearT, DIST_POWER);
      blinkTmp.multiplyScalar(distFactor);
      // White-wash: closest dots lerp toward white (flash overexposure)
      var wash = nearT > 0.5 ? (nearT - 0.5) * 2 * FRONT_WHITE_WASH : 0;
      blinkTmp.lerp(white, wash);

      dots.setColorAt(i, blinkTmp);
    }
    dots.instanceColor.needsUpdate = true;

    renderer.render(scene, camera);
  }

  animate();

  /* ── Resize ─────────────────────────────────────────────────────────────── */
  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
})();
