import { createServer } from 'vite';
import { chromium } from 'playwright';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = '/home/user/mario.cone';
const COURSE = process.argv[2] || 'jackhammer-quarry';

const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.log('ERR', m.text()); });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120000 });

const call = (fn, ...args) => page.evaluate(([f, a]) => {
  const r = window.__GAME[f](...a);
  return r instanceof Promise ? r.then(() => null) : (r ?? null);
}, [fn, args]);

await call('reset', { vehicleId: 'cone', courseId: COURSE, seed: 1, instant: true });
await call('setAutopilot', true);
await call('step', 9);
await call('setTimeScale', 0);
for (let i = 0; i < 12; i++) await call('render');

const EL = 0.50;
for (const az of [0.64, 1.12, 5.64, 4.60]) {
  await page.evaluate(([az, el]) => {
    const ctx = window.__DBGCTX;
    let sky = null;
    ctx.scene.traverse((o) => { if (o.material && o.material.uniforms && o.material.uniforms.uSunDir) sky = o; });
    const azp = az + Math.PI * 0.5;
    const d = new ctx.THREE.Vector3(Math.cos(el) * Math.cos(azp), Math.sin(el), Math.cos(el) * Math.sin(azp)).normalize();
    sky.material.uniforms.uSunDir.value.copy(d);
  }, [az, EL]);
  const st = await page.evaluate(() => {
    window.__GAME.render();
    const c = document.querySelector('canvas');
    const o = document.createElement('canvas');
    o.width = c.width; o.height = c.height;
    const g2 = o.getContext('2d');
    g2.drawImage(c, 0, 0);
    const d = g2.getImageData(0, 0, o.width, o.height).data;
    let dark = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] <= 8 && d[i + 1] <= 8 && d[i + 2] <= 8) dark++;
      sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    }
    const n = o.width * o.height;
    return { dark: dark / n * 100, mean: sum / n };
  });
  const dark = st.dark, mean = st.mean;
  console.log(`az=${az.toFixed(2)} dark=${dark.toFixed(2)}% mean=${mean.toFixed(1)}`);
  await page.locator('canvas').first().screenshot({ path: `/tmp/az/az-${az.toFixed(2)}.png` });
}

await browser.close();
await server.close();
