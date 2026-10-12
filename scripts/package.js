// Zero-dependency vsix packager: Node stdlib only (fs, path, zlib).
// A vsix is a plain zip archive; the minimal writer below produces it
// without archiver nor vsce and their vulnerable dependency trees.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Go back to the project root directory
const projectRoot = path.resolve(__dirname, '..');

// Read the metadata from package.json
const packageJson = require(path.join(projectRoot, 'package.json'));
const vsixFilename = path.join(projectRoot, `${packageJson.name}-${packageJson.version}.vsix`);

// Escape a value interpolated into the generated XML manifests.
function escapeXml(aValue) {
    return String(aValue)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Content of the [Content_Types].xml file
const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="css" ContentType="text/css"/>
  <Default Extension="html" ContentType="text/html"/>
  <Default Extension="xml" ContentType="text/xml"/>
  <Default Extension="txt" ContentType="text/plain"/>
</Types>`;

// Content of the extension.vsixmanifest file
const vsixManifestTemplate = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(packageJson.name)}" Version="${escapeXml(packageJson.version)}" Publisher="${escapeXml(packageJson.publisher)}" />
    <DisplayName>${escapeXml(packageJson.displayName || packageJson.name)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(packageJson.description)}</Description>
    <Tags>${escapeXml((packageJson.keywords || []).join(','))}</Tags>
    <Categories>${escapeXml((packageJson.categories || []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Manifest" Path="extension.vsixmanifest" Addressable="true" />
  </Assets>
</PackageManifest>`;

// ------------------------------------------------------------
// CRC32 (zip checksum)
// ------------------------------------------------------------
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let tableIndex = 0; tableIndex < 256; tableIndex++) {
        let crcValue = tableIndex;
        for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
            crcValue = (crcValue & 1) ? (0xEDB88320 ^ (crcValue >>> 1)) : (crcValue >>> 1);
        }
        table[tableIndex] = crcValue >>> 0;
    }
    return table;
})();

function crc32(aBuffer) {
    let crcValue = 0xFFFFFFFF;
    for (let byteIndex = 0; byteIndex < aBuffer.length; byteIndex++) {
        crcValue = CRC_TABLE[(crcValue ^ aBuffer[byteIndex]) & 0xFF] ^ (crcValue >>> 8);
    }
    return (crcValue ^ 0xFFFFFFFF) >>> 0;
}

// ------------------------------------------------------------
// Minimal zip writer (deflate entries + central directory + end record)
// ------------------------------------------------------------
function toDosDateTime(aDate) {
    const dosTime = (aDate.getHours() << 11) | (aDate.getMinutes() << 5) | (aDate.getSeconds() >> 1);
    const dosDate = (((aDate.getFullYear() - 1980) & 0x7F) << 9) | ((aDate.getMonth() + 1) << 5) | aDate.getDate();
    return { dosTime: dosTime, dosDate: dosDate };
}

class ZipWriter {
    constructor() {
        this.localChunks = [];
        this.centralEntries = [];
        this.currentOffset = 0;
        this.stamp = toDosDateTime(new Date());
    }

    addFile(aEntryName, aDataBuffer) {
        const nameBuffer = Buffer.from(aEntryName.replace(/\\/g, '/'), 'utf8');
        const compressedData = zlib.deflateRawSync(aDataBuffer, { level: 9 });
        const crcValue = crc32(aDataBuffer);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034B50, 0);                   // local file header signature
        localHeader.writeUInt16LE(20, 4);                           // version needed to extract
        localHeader.writeUInt16LE(0x0800, 6);                       // flags: UTF-8 names
        localHeader.writeUInt16LE(8, 8);                            // compression: deflate
        localHeader.writeUInt16LE(this.stamp.dosTime, 10);
        localHeader.writeUInt16LE(this.stamp.dosDate, 12);
        localHeader.writeUInt32LE(crcValue, 14);
        localHeader.writeUInt32LE(compressedData.length, 18);
        localHeader.writeUInt32LE(aDataBuffer.length, 22);
        localHeader.writeUInt16LE(nameBuffer.length, 26);
        localHeader.writeUInt16LE(0, 28);                           // extra field length

        this.centralEntries.push({
            nameBuffer: nameBuffer,
            crcValue: crcValue,
            compressedSize: compressedData.length,
            uncompressedSize: aDataBuffer.length,
            localHeaderOffset: this.currentOffset,
        });
        this.localChunks.push(localHeader, nameBuffer, compressedData);
        this.currentOffset += localHeader.length + nameBuffer.length + compressedData.length;
    }

    toBuffer() {
        const centralChunks = [];
        let centralSize = 0;
        for (const entry of this.centralEntries) {
            const centralHeader = Buffer.alloc(46);
            centralHeader.writeUInt32LE(0x02014B50, 0);             // central directory signature
            centralHeader.writeUInt16LE(20, 4);                     // version made by
            centralHeader.writeUInt16LE(20, 6);                     // version needed to extract
            centralHeader.writeUInt16LE(0x0800, 8);                 // flags: UTF-8 names
            centralHeader.writeUInt16LE(8, 10);                     // compression: deflate
            centralHeader.writeUInt16LE(this.stamp.dosTime, 12);
            centralHeader.writeUInt16LE(this.stamp.dosDate, 14);
            centralHeader.writeUInt32LE(entry.crcValue, 16);
            centralHeader.writeUInt32LE(entry.compressedSize, 20);
            centralHeader.writeUInt32LE(entry.uncompressedSize, 24);
            centralHeader.writeUInt16LE(entry.nameBuffer.length, 28);
            centralHeader.writeUInt16LE(0, 30);                     // extra field length
            centralHeader.writeUInt16LE(0, 32);                     // comment length
            centralHeader.writeUInt16LE(0, 34);                     // disk number start
            centralHeader.writeUInt16LE(0, 36);                     // internal attributes
            centralHeader.writeUInt32LE(0, 38);                     // external attributes
            centralHeader.writeUInt32LE(entry.localHeaderOffset, 42);
            centralChunks.push(centralHeader, entry.nameBuffer);
            centralSize += centralHeader.length + entry.nameBuffer.length;
        }

        const endRecord = Buffer.alloc(22);
        endRecord.writeUInt32LE(0x06054B50, 0);                     // end of central directory signature
        endRecord.writeUInt16LE(0, 4);                              // disk number
        endRecord.writeUInt16LE(0, 6);                              // central directory start disk
        endRecord.writeUInt16LE(this.centralEntries.length, 8);
        endRecord.writeUInt16LE(this.centralEntries.length, 10);
        endRecord.writeUInt32LE(centralSize, 12);
        endRecord.writeUInt32LE(this.currentOffset, 16);
        endRecord.writeUInt16LE(0, 20);                             // comment length

        return Buffer.concat([...this.localChunks, ...centralChunks, endRecord]);
    }
}

// ------------------------------------------------------------
// Archive content
// ------------------------------------------------------------
const zipWriter = new ZipWriter();

// Recursively add a folder and its content
function addDirectoryToArchive(aDirPath, aEntryPrefix) {
    const dirEntries = fs.readdirSync(aDirPath, { withFileTypes: true });
    for (const dirEntry of dirEntries) {
        const fullPath = path.join(aDirPath, dirEntry.name);
        const entryName = `${aEntryPrefix}/${dirEntry.name}`;
        if (dirEntry.isDirectory()) {
            addDirectoryToArchive(fullPath, entryName);
        } else {
            zipWriter.addFile(`extension/${entryName}`, fs.readFileSync(fullPath));
        }
    }
}

// Generated files (in memory, no temporary files on disk)
zipWriter.addFile('[Content_Types].xml', Buffer.from(contentTypesXml, 'utf8'));
zipWriter.addFile('extension.vsixmanifest', Buffer.from(vsixManifestTemplate, 'utf8'));

// Individual files to include
const filesToInclude = [
    'package.json',
    'readme.md',
    'changelog.md',
    'LICENSE'
];

// Folders to include
const foldersToInclude = [
    'medias',
    'schemas',
    'out'
];

// Add the individual files
filesToInclude.forEach(fileName => {
    const filePath = path.join(projectRoot, fileName);
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
        zipWriter.addFile(`extension/${fileName}`, fs.readFileSync(filePath));
    } else {
        console.warn(`Warning: the file '${fileName}' does not exist or is not a file.`);
    }
});

// Add the folders and their content
foldersToInclude.forEach(folderName => {
    const folderPath = path.join(projectRoot, folderName);
    if (fs.existsSync(folderPath) && fs.lstatSync(folderPath).isDirectory()) {
        addDirectoryToArchive(folderPath, folderName);
    } else {
        console.warn(`Warning: the folder '${folderName}' does not exist or is not a directory.`);
    }
});

// Write the package file
const vsixBuffer = zipWriter.toBuffer();
fs.writeFileSync(vsixFilename, vsixBuffer);
console.log(`[CodeAnonymizer] Extension packaged successfully: ${vsixFilename} (${zipWriter.centralEntries.length} files, ${(vsixBuffer.length / 1024).toFixed(1)} KiB)`);
