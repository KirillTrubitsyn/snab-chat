import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(__dirname, '../public/slide-contractors.html');
const pdfPath = path.resolve(__dirname, '../public/slide-contractors.pdf');

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
await page.goto(`file://${htmlPath}`, { waitUntil: 'load', timeout: 10000 });

await page.pdf({
  path: pdfPath,
  width: '1920px',
  height: '1080px',
  printBackground: true,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
  pageRanges: '1',
});

await browser.close();
console.log(`PDF saved: ${pdfPath}`);
