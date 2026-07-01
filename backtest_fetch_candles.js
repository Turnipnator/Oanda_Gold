#!/usr/bin/env node
/**
 * Fetch & cache XAU_USD candles from Oanda for backtesting.
 * H1 (primary), H4 (HTF), M5 (management). Paginates by time (max 5000/req).
 * Writes {H1,H4,M5}.json to the scratchpad dir given as argv[2]. Key via OANDA_API_KEY.
 */
import fs from 'fs';
const HOST = 'https://api-fxpractice.oanda.com';
const KEY = process.env.OANDA_API_KEY;
const H = { Authorization: `Bearer ${KEY}` };
const INSTR = 'XAU_USD';
const OUT = process.argv[2];
const FROM = process.argv[3] || '2024-07-01T00:00:00Z';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function page(granularity) {
  const all = [];
  let from = FROM;
  const nowSafe = new Date(Date.now() - 6 * 60e3).toISOString();
  while (true) {
    const u = new URL(`${HOST}/v3/instruments/${INSTR}/candles`);
    u.search = new URLSearchParams({ from, granularity, price: 'M', count: '5000' }).toString();
    let data;
    for (let a = 0; a < 4; a++) {
      try { const r = await fetch(u, { headers: H }); if (!r.ok) throw new Error(r.status + ' ' + await r.text()); data = await r.json(); break; }
      catch (e) { if (a === 3) throw e; await sleep(600 * (a + 1)); }
    }
    const cs = (data.candles || []).filter(c => c.complete).map(c => ({ time: c.time, open: +c.mid.o, high: +c.mid.h, low: +c.mid.l, close: +c.mid.c, complete: true }));
    if (!cs.length) break;
    // avoid dup on boundary
    const startIdx = all.length && cs[0].time === all[all.length - 1].time ? 1 : 0;
    for (let i = startIdx; i < cs.length; i++) all.push(cs[i]);
    const last = cs[cs.length - 1].time;
    if (cs.length < 4999 || last >= nowSafe) break;
    from = new Date(new Date(last).getTime() + 1000).toISOString();
    await sleep(120);
  }
  return all;
}

async function main() {
  for (const g of ['H4', 'H1', 'M5']) {
    process.stdout.write(`fetching ${g}... `);
    const cs = await page(g);
    fs.writeFileSync(`${OUT}/${g}.json`, JSON.stringify(cs));
    console.log(`${cs.length} candles  [${cs[0]?.time?.slice(0,10)} → ${cs[cs.length-1]?.time?.slice(0,10)}]`);
  }
}
main().catch(e => { console.error('FETCH ERR', e.message); process.exit(1); });
