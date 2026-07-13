"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function crc32(data) {
  let crc = 0xffffffff;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const h = date.getHours();
  const min = date.getMinutes();
  const s = date.getSeconds();
  const time = (h << 11) | (min << 5) | (s >> 1);
  const dateBits = ((y - 1980) << 9) | (m << 5) | d;
  return { time, date: dateBits };
}

function makeLocalFileHeader(fileName, compressedSize, uncompressedSize, crc, dos) {
  const nameBuf = Buffer.from(fileName, "utf8");
  const buf = Buffer.alloc(30 + nameBuf.length);
  buf.writeUInt32LE(0x04034b50, 0);
  buf.writeUInt16LE(20, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(0, 8);
  buf.writeUInt16LE(8, 10);
  buf.writeUInt16LE(dos.time, 12);
  buf.writeUInt16LE(dos.date, 14);
  buf.writeUInt32LE(crc, 16);
  buf.writeUInt32LE(compressedSize, 20);
  buf.writeUInt32LE(uncompressedSize, 24);
  buf.writeUInt16LE(nameBuf.length, 28);
  buf.writeUInt16LE(0, 30);
  nameBuf.copy(buf, 30);
  return buf;
}

function makeCentralDirEntry(fileName, compressedSize, uncompressedSize, crc, dos, localOffset) {
  const nameBuf = Buffer.from(fileName, "utf8");
  const buf = Buffer.alloc(46 + nameBuf.length);
  buf.writeUInt32LE(0x02014b50, 0);
  buf.writeUInt16LE(20, 4);
  buf.writeUInt16LE(20, 6);
  buf.writeUInt16LE(0, 8);
  buf.writeUInt16LE(0, 10);
  buf.writeUInt16LE(8, 12);
  buf.writeUInt16LE(dos.time, 14);
  buf.writeUInt16LE(dos.date, 16);
  buf.writeUInt32LE(crc, 18);
  buf.writeUInt32LE(compressedSize, 22);
  buf.writeUInt32LE(uncompressedSize, 26);
  buf.writeUInt16LE(nameBuf.length, 30);
  buf.writeUInt16LE(0, 32);
  buf.writeUInt16LE(0, 34);
  buf.writeUInt16LE(0, 36);
  buf.writeUInt16LE(0, 38);
  buf.writeUInt16LE(0, 40);
  buf.writeUInt32LE(localOffset, 42);
  nameBuf.copy(buf, 46);
  return buf;
}

function makeEndOfCentralDir(numEntries, centralSize, centralOffset) {
  const comment = Buffer.from("MRGMinner evidence package", "utf8");
  const buf = Buffer.alloc(22 + comment.length);
  buf.writeUInt32LE(0x06054b50, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(numEntries, 8);
  buf.writeUInt16LE(numEntries, 10);
  buf.writeUInt32LE(centralSize, 12);
  buf.writeUInt32LE(centralOffset, 16);
  buf.writeUInt16LE(comment.length, 20);
  comment.copy(buf, 22);
  return buf;
}

async function zipDirectory(sourceDir, outputPath) {
  const entries = [];
  collectEntries(sourceDir, "", entries);

  const fd = await fs.promises.open(outputPath, "w");
  try {
    const fileEntries = [];
    let localOffset = 0;
    const dos = dosDateTime();

    for (const entry of entries) {
      const fullPath = path.join(sourceDir, entry.relativePath);
      const stat = await fs.promises.stat(fullPath);
      const data = stat.isDirectory() ? Buffer.alloc(0) : await fs.promises.readFile(fullPath);
      const compressed = stat.isDirectory() ? Buffer.alloc(0) : zlib.deflateRawSync(data);
      const crc = stat.isDirectory() ? 0 : crc32(data);
      const name = entry.relativePath.replace(/\\/g, "/") + (stat.isDirectory() ? "/" : "");

      const header = makeLocalFileHeader(name, compressed.length, data.length, crc, dos);
      await fd.write(header, 0, header.length, null);
      if (compressed.length > 0) {
        await fd.write(compressed, 0, compressed.length, null);
      }

      fileEntries.push({ name, compressedSize: compressed.length, uncompressedSize: data.length, crc, dos, localOffset });
      localOffset += header.length + compressed.length;
    }

    const centralStart = localOffset;
    const centralEntries = [];
    for (const fe of fileEntries) {
      const entry = makeCentralDirEntry(fe.name, fe.compressedSize, fe.uncompressedSize, fe.crc, fe.dos, fe.localOffset);
      centralEntries.push(entry);
      await fd.write(entry, 0, entry.length, null);
    }
    const centralSize = centralEntries.reduce((sum, e) => sum + e.length, 0);

    const eocd = makeEndOfCentralDir(fileEntries.length, centralSize, centralStart);
    await fd.write(eocd, 0, eocd.length, null);
  } finally {
    await fd.close();
  }

  return outputPath;
}

function collectEntries(dir, prefix, entries) {
  const names = fs.readdirSync(dir);
  for (const name of names) {
    const fullPath = path.join(dir, name);
    const stat = fs.statSync(fullPath);
    entries.push({ relativePath: prefix ? path.join(prefix, name) : name });
    if (stat.isDirectory()) {
      collectEntries(fullPath, prefix ? path.join(prefix, name) : name, entries);
    }
  }
}

module.exports = { zipDirectory, crc32 };
