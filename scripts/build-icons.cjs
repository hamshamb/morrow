// Rasterizes the Morrow logo SVGs into the app icons, using Electron's own renderer (no extra deps).
//
//   apps/desktop/resources/icon.png  512x512, window/taskbar icon at runtime
//   apps/desktop/resources/icon.ico  16-256 px, Windows executable/installer/shortcut icon
//
// Sizes up to 48 px are redrawn on that size's own pixel grid (PIXEL_GRID below) so the bars land on
// whole pixels and stay sharp in the taskbar; larger sizes scale icon.svg.
// Usage (from the repo root): pnpm icons
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const dir = join(__dirname, '..', 'apps', 'desktop', 'resources')
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const INK = '#161616'
const PAPER = '#e9e5da'
const SIGNAL = '#f07361'

// Per size: sun [cx, baseline y, r]; horizon / line / cursor bars as [x, y, w, h].
const PIXEL_GRID = {
  16: { sun: [8, 8, 5], horizon: [1, 8, 14, 2], line: [1, 11, 8, 2], cursor: [11, 11, 2, 2] },
  20: { sun: [10, 10, 6], horizon: [2, 10, 16, 2], line: [2, 14, 9, 2], cursor: [13, 14, 2, 2] },
  24: { sun: [12, 12, 7], horizon: [2, 12, 20, 3], line: [2, 17, 11, 3], cursor: [15, 17, 3, 3] },
  32: { sun: [16, 16, 9], horizon: [3, 16, 26, 3], line: [3, 22, 15, 3], cursor: [20, 22, 3, 3] },
  40: { sun: [20, 21, 11], horizon: [5, 21, 30, 3], line: [5, 27, 18, 3], cursor: [26, 27, 3, 3] },
  48: { sun: [24, 25, 13], horizon: [6, 25, 36, 4], line: [6, 33, 22, 4], cursor: [31, 33, 4, 4] },
}

function gridSvgUrl(size) {
  const g = PIXEL_GRID[size]
  const [cx, y, r] = g.sun
  const bar = ([x, by, w, h], fill) => `<rect x="${x}" y="${by}" width="${w}" height="${h}" fill="${fill}"/>`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="${INK}"/>` +
    `<path d="M${cx - r} ${y}a${r} ${r} 0 0 1 ${2 * r} 0z" fill="${SIGNAL}" shape-rendering="geometricPrecision"/>` +
    bar(g.horizon, PAPER) + bar(g.line, PAPER) + bar(g.cursor, SIGNAL) +
    `</svg>`
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
}

function svgUrl(name) {
  return 'data:image/svg+xml;base64,' + readFileSync(join(dir, name)).toString('base64')
}

async function rasterize(win, url, size) {
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = c.height = ${size}
      const ctx = c.getContext('2d')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, ${size}, ${size})
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = reject
    img.src = ${JSON.stringify(url)}
  })`)
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

// ICO container holding PNG-compressed images (supported since Windows Vista).
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + 16 * images.length
  for (const { size, png } of images) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
    await win.loadURL('data:text/html,<body></body>')
    const large = svgUrl('icon.svg')
    const images = []
    for (const size of ICO_SIZES) {
      images.push({ size, png: await rasterize(win, PIXEL_GRID[size] ? gridSvgUrl(size) : large, size) })
    }
    writeFileSync(join(dir, 'icon.ico'), ico(images))
    writeFileSync(join(dir, 'icon.png'), await rasterize(win, large, 512))
    console.log(`Wrote icon.ico (${ICO_SIZES.join(', ')}) and icon.png (512) to ${dir}`)
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
