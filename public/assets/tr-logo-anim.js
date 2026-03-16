/**
 * terrain.run — TR Logo Animation
 * Loads the SVG, attaches hover-triggered inverse wave in burnt orange
 * Usage: initTRLogo('#my-container', { size: 48 })
 */
async function initTRLogo(selector, opts = {}) {
  const container = document.querySelector(selector);
  if (!container) return;

  const size = opts.size || 48;
  const color = opts.color || '#ee5218';

  // Fetch the SVG
  const resp = await fetch('/assets/tr-logo.svg');
  const svgText = await resp.text();

  // Parse and extract paths
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const srcPaths = doc.querySelectorAll('path');

  // Build inline SVG
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 1024 1024');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.style.display = 'block';

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('transform', 'translate(0,1024) scale(0.1,-0.1)');
  g.setAttribute('fill', color);
  g.setAttribute('fill-opacity', '0.6');
  g.setAttribute('stroke', 'none');

  // Calculate spatial data for each path
  const pathEls = [];
  const coords = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  srcPaths.forEach(sp => {
    const d = sp.getAttribute('d');
    const m = d.match(/^M(\d+)\s+(\d+)/);
    if (m) {
      const x = parseInt(m[1]), y = parseInt(m[2]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      coords.push({ x, y, d });
    }
  });

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  coords.forEach(c => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', c.d);
    const nx = (c.x - minX) / rangeX;
    const ny = (c.y - minY) / rangeY;
    const dist = Math.sqrt((nx - 0.5) ** 2 + (ny - 0.5) ** 2);
    path._dist = dist;
    path._nx = nx;
    path._ny = ny;
    g.appendChild(path);
    pathEls.push(path);
  });

  svg.appendChild(g);
  container.appendChild(svg);

  // Animation state
  let animFrame = null;
  let startTime = 0;
  const SPEED = 4; // 4x speed as requested

  function runWave(now) {
    const elapsed = ((now - startTime) / 1000) * SPEED;

    pathEls.forEach(p => {
      // Inverse wave: starts bright, ripples to dark
      // Center lights up first, outer paths follow
      const phase = (elapsed * 2.5 - p._dist * 5);
      // Sharp bright pulse that fades
      const brightness = Math.max(0.08, Math.pow(Math.max(0, Math.cos(phase)), 2));
      p.setAttribute('fill-opacity', brightness);
    });

    animFrame = requestAnimationFrame(runWave);
  }

  function startAnimation() {
    if (animFrame) return;
    startTime = performance.now();
    animFrame = requestAnimationFrame(runWave);
  }

  function stopAnimation() {
    if (animFrame) {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }
    // Fade back to static
    pathEls.forEach(p => {
      p.setAttribute('fill-opacity', '0.6');
    });
  }

  // Hover triggers
  container.addEventListener('mouseenter', startAnimation);
  container.addEventListener('mouseleave', stopAnimation);

  // Also allow touch
  container.addEventListener('touchstart', startAnimation, { passive: true });
  container.addEventListener('touchend', stopAnimation, { passive: true });

  container.style.cursor = 'pointer';
}
