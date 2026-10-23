import { chromium } from "playwright-core";
import fs from "node:fs";
const svg = (pad) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${32 + pad * 2} ${32 + pad * 2}"><rect x="${-pad}" y="${-pad}" width="${32 + pad * 2}" height="${32 + pad * 2}" fill="#4f46e5"/><path d="M12 8h8v2.5h-2.75v11H20V24h-8v-2.5h2.75v-11H12z" fill="#fff"/></svg>`;
const out = process.argv[2];
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const jobs = [
  ["icon-192.png", 192, 0],
  ["icon-512.png", 512, 0],
  ["icon-maskable-512.png", 512, 8],
  ["apple-icon.png", 180, 0],
];
for (const [name, size, pad] of jobs) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(
    `<body style="margin:0">${svg(pad).replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`,
  );
  fs.writeFileSync(`${out}/${name}`, await p.screenshot());
}
await b.close();
