import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const server = await createServer({ root: ROOT, logLevel:'error', server:{host:'127.0.0.1',port:0}, optimizeDeps:{include:['three']} });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport:{width:1280,height:720} });
const msgs = [];
page.on('console', m => msgs.push(`${m.type()}: ${m.text().slice(0,180)}`));
page.on('pageerror', e => msgs.push(`pageerror: ${e.message.slice(0,180)}`));
await page.goto(url, { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForFunction(()=>window.__GAME?.ready===true, null, {timeout:180000});
console.log('--- sitting on the untouched front-end for 30s ---');
for (let i=0;i<6;i++){
  await new Promise(r=>setTimeout(r,5000));
  const s = await page.evaluate(()=>{ const st=window.__GAME.stats(); return {gov:st.governor, skip:st.drawSkipped, draws:st.drawCalls, tris:st.triangles, rung:st.rung, phase:window.__GAME.snapshot().race.phase}; });
  console.log(`  +${(i+1)*5}s`, JSON.stringify(s));
}
await page.screenshot({ path:'/tmp/perf-menu.png' });
console.log('\n--- console since boot ---');
for (const m of msgs) console.log('  ', m);
await browser.close(); await server.close();
