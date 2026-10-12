// Zero-dependency extension icon generator: node scripts/genIcon.js
// Renders medias/icon.png (128x128): a dark rounded card with four code
// lines, two of them redacted, and a shield (the CodeAnonymizer motif).
// Node stdlib only (fs, path, zlib), same philosophy as package.js.
// Drawn at 4x then box-filtered down so the edges are antialiased.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const SCALE = 4;
const CANVAS = SIZE * SCALE;
const canvas = Buffer.alloc(CANVAS * CANVAS * 4); // RGBA, transparent by default

function setPixel(aX, aY, aColor) {
    if (aX < 0 || aY < 0 || aX >= CANVAS || aY >= CANVAS) {
        return;
    }
    const offset = (aY * CANVAS + aX) * 4;
    canvas[offset] = aColor[0];
    canvas[offset + 1] = aColor[1];
    canvas[offset + 2] = aColor[2];
    canvas[offset + 3] = aColor[3];
}

// Coordinates below are in icon pixels (0..128), scaled to the canvas here.
function fillRoundedRect(aLeft, aTop, aWidth, aHeight, aRadius, aColor) {
    const left = aLeft * SCALE;
    const top = aTop * SCALE;
    const width = aWidth * SCALE;
    const height = aHeight * SCALE;
    const radius = aRadius * SCALE;
    for (let y = top; y < top + height; y++) {
        for (let x = left; x < left + width; x++) {
            const cornerX = Math.max(left + radius - x, x - (left + width - 1 - radius), 0);
            const cornerY = Math.max(top + radius - y, y - (top + height - 1 - radius), 0);
            if (cornerX * cornerX + cornerY * cornerY <= radius * radius) {
                setPixel(x, y, aColor);
            }
        }
    }
}

function fillTriangle(aPoints, aColor) {
    const points = aPoints.map(([x, y]) => [x * SCALE, y * SCALE]);
    const minX = Math.floor(Math.min(...points.map((p) => p[0])));
    const maxX = Math.ceil(Math.max(...points.map((p) => p[0])));
    const minY = Math.floor(Math.min(...points.map((p) => p[1])));
    const maxY = Math.ceil(Math.max(...points.map((p) => p[1])));
    const edge = (a, b, x, y) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const e0 = edge(points[0], points[1], x, y);
            const e1 = edge(points[1], points[2], x, y);
            const e2 = edge(points[2], points[0], x, y);
            if ((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0)) {
                setPixel(x, y, aColor);
            }
        }
    }
}

// ---- compose the icon ----
const BACKGROUND = [30, 30, 40, 255];
const REDACTED_COLOR = [90, 90, 105, 255];
const SHIELD_COLOR = [70, 200, 120, 255];
const LINE_COLORS = [
    [70, 150, 220, 255],
    [240, 180, 70, 255],
    [231, 96, 70, 255],
    [70, 150, 220, 255]
];

fillRoundedRect(4, 4, SIZE - 8, SIZE - 8, 26, BACKGROUND);

// Code lines, two of them redacted: the result of an anonymization
const LINE_LEFT = 20;
const LINE_HEIGHT = 11;
const LINES = [
    { width: 50, redacted: false },
    { width: 74, redacted: true },
    { width: 62, redacted: true },
    { width: 40, redacted: false }
];
LINES.forEach((aLine, aIndex) => {
    const color = aLine.redacted ? REDACTED_COLOR : LINE_COLORS[aIndex];
    const radius = aLine.redacted ? 2 : LINE_HEIGHT / 2;
    fillRoundedRect(LINE_LEFT, 28 + aIndex * 19, aLine.width, LINE_HEIGHT, radius, color);
});

// Shield in the bottom-right corner: rounded top, pointed bottom
fillRoundedRect(84, 76, 28, 20, 5, SHIELD_COLOR);
fillTriangle([[84, 90], [112, 90], [98, 110]], SHIELD_COLOR);
fillRoundedRect(95, 81, 6, 15, 3, BACKGROUND);

// ---- downsample (box filter, premultiplied alpha) ----
const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
        let red = 0;
        let green = 0;
        let blue = 0;
        let alpha = 0;
        for (let subY = 0; subY < SCALE; subY++) {
            for (let subX = 0; subX < SCALE; subX++) {
                const offset = ((y * SCALE + subY) * CANVAS + x * SCALE + subX) * 4;
                const subAlpha = canvas[offset + 3];
                red += canvas[offset] * subAlpha;
                green += canvas[offset + 1] * subAlpha;
                blue += canvas[offset + 2] * subAlpha;
                alpha += subAlpha;
            }
        }
        const offset = (y * SIZE + x) * 4;
        if (alpha > 0) {
            pixels[offset] = Math.round(red / alpha);
            pixels[offset + 1] = Math.round(green / alpha);
            pixels[offset + 2] = Math.round(blue / alpha);
            pixels[offset + 3] = Math.round(alpha / (SCALE * SCALE));
        }
    }
}

// ---- minimal PNG writer (signature + IHDR + IDAT + IEND) ----
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let tableIndex = 0; tableIndex < 256; tableIndex++) {
        let crcValue = tableIndex;
        for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
            crcValue = crcValue & 1 ? 0xedb88320 ^ (crcValue >>> 1) : crcValue >>> 1;
        }
        table[tableIndex] = crcValue >>> 0;
    }
    return table;
})();

function crc32(aBuffer) {
    let crcValue = 0xffffffff;
    for (let byteIndex = 0; byteIndex < aBuffer.length; byteIndex++) {
        crcValue = CRC_TABLE[(crcValue ^ aBuffer[byteIndex]) & 0xff] ^ (crcValue >>> 8);
    }
    return (crcValue ^ 0xffffffff) >>> 0;
}

function makeChunk(aType, aData) {
    const chunk = Buffer.alloc(12 + aData.length);
    chunk.writeUInt32BE(aData.length, 0);
    chunk.write(aType, 4, 'ascii');
    aData.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + aData.length)), 8 + aData.length);
    return chunk;
}

const ihdrData = Buffer.alloc(13);
ihdrData.writeUInt32BE(SIZE, 0);
ihdrData.writeUInt32BE(SIZE, 4);
ihdrData[8] = 8; // bit depth
ihdrData[9] = 6; // color type RGBA
const scanlines = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
    // filter byte 0 (None) then the row
    pixels.copy(scanlines, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const pngBuffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    makeChunk('IEND', Buffer.alloc(0))
]);

const outputPath = path.join(path.resolve(__dirname, '..'), 'medias', 'icon.png');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, pngBuffer);
console.log(`[CodeAnonymizer] icon written: ${outputPath} (${pngBuffer.length} bytes)`);
