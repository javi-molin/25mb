/* Divisor de ZIP: reparte el contenido de un ZIP grande en varios ZIP de como máximo N MB.
 * Todo ocurre en el navegador: los archivos nunca salen del ordenador. */
"use strict";

const { ZipReader, ZipWriter, BlobReader, BlobWriter, configure } = zip;
configure({ useWebWorkers: false });

const MB = 1024 * 1024;
const encoder = new TextEncoder();
const collator = new Intl.Collator("es", { numeric: true, sensitivity: "base" });

// Extensiones que ya vienen comprimidas: comprimirlas otra vez solo gasta tiempo.
const COMPRESSED_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "heic", "avif", "mp4", "mov", "m4v", "mkv", "webm", "avi", "3gp",
  "mp3", "m4a", "aac", "ogg", "opus", "flac", "zip", "rar", "7z", "gz", "bz2", "xz", "pdf", "docx",
  "xlsx", "pptx", "apk", "jar",
]);

// Bytes de cabeceras que añade cada entrada (local + descriptor + directorio central), con margen.
function entryOverhead(name) {
  return 2 * encoder.encode(name).length + 320;
}
const ZIP_TAIL = 22 + 56 + 20 + 1024; // fin de directorio (+ zip64) y margen
const README_RESERVE = 8 * 1024;

function estimate(entry) {
  return (entry.directory ? 0 : entry.compressedSize) + entryOverhead(entry.filename);
}

function formatSize(bytes) {
  if (bytes >= MB) return (bytes / MB).toFixed(2).replace(".", ",") + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1).replace(".", ",") + " KB";
  return bytes + " B";
}

/* ---------- Agrupación inteligente ---------- */

function newNode(path) {
  return { path, dirs: new Map(), files: [], dirEntry: null, size: 0 };
}

function buildTree(entries) {
  const root = newNode("");
  for (const entry of entries) {
    const parts = entry.filename.split("/").filter(Boolean);
    const dirParts = entry.directory ? parts : parts.slice(0, -1);
    let node = root;
    for (const part of dirParts) {
      if (!node.dirs.has(part)) node.dirs.set(part, newNode(node.path + part + "/"));
      node = node.dirs.get(part);
    }
    if (entry.directory) node.dirEntry = entry;
    else node.files.push(entry);
  }
  computeSize(root);
  return root;
}

function computeSize(node) {
  let size = node.dirEntry ? estimate(node.dirEntry) : 0;
  for (const file of node.files) size += estimate(file);
  for (const child of node.dirs.values()) size += computeSize(child);
  node.size = size;
  return size;
}

// Hijos de una carpeta (archivos y subcarpetas) en orden natural por nombre.
function children(node) {
  const list = [];
  for (const file of node.files) list.push({ name: file.filename.split("/").pop(), file });
  for (const [name, dir] of node.dirs) list.push({ name, dir });
  return list.sort((a, b) => collator.compare(a.name, b.name));
}

function flatten(node, out = []) {
  if (node.dirEntry) out.push(node.dirEntry);
  for (const child of children(node)) {
    if (child.file) out.push(child.file);
    else flatten(child.dir, out);
  }
  return out;
}

/* Convierte el árbol en "bloques" indivisibles:
 *  - una carpeta que cabe entera es un único bloque (así un chat no se separa);
 *  - una carpeta demasiado grande se corta en tramos consecutivos y casi llenos;
 *  - un archivo que por sí solo supera el límite se marca para trocearlo. */
function makeUnits(node, budget, units, oversize) {
  if (node.size <= budget) {
    units.push({ entries: flatten(node), size: node.size });
    return;
  }
  let current = null;
  const flush = () => {
    if (current && current.entries.length) units.push(current);
    current = null;
  };
  const add = (entries, size) => {
    if (!current || current.size + size > budget) {
      flush();
      current = { entries: [], size: 0 };
    }
    current.entries.push(...entries);
    current.size += size;
  };
  if (node.dirEntry) add([node.dirEntry], estimate(node.dirEntry));
  for (const child of children(node)) {
    if (child.file) {
      const size = estimate(child.file);
      if (size > budget) oversize.push(child.file);
      else add([child.file], size);
    } else if (child.dir.size <= budget) {
      add(flatten(child.dir), child.dir.size);
    } else {
      flush();
      makeUnits(child.dir, budget, units, oversize);
    }
  }
  flush();
}

// Reparte los bloques en el mínimo de partes posible (first-fit decreasing).
function packUnits(units, budget) {
  const bins = [];
  for (const unit of [...units].sort((a, b) => b.size - a.size)) {
    let bin = bins.find((b) => b.size + unit.size <= budget);
    if (!bin) bins.push((bin = { entries: [], size: 0 }));
    bin.entries.push(...unit.entries);
    bin.size += unit.size;
  }
  for (const bin of bins) bin.entries.sort((a, b) => collator.compare(a.filename, b.filename));
  return bins.sort((a, b) => collator.compare(a.entries[0].filename, b.entries[0].filename));
}

function plan(entries, budget) {
  const units = [];
  const oversize = [];
  makeUnits(buildTree(entries), budget, units, oversize);
  return { units, oversize: oversize.sort((a, b) => collator.compare(a.filename, b.filename)) };
}

/* ---------- Escritura de ZIP sin streams ----------
 * Los ZIP de salida se montan a mano: cabeceras + los bytes comprimidos originales, tomados con
 * Blob.slice() directamente del archivo subido. No se descomprime ni se recomprime nada, apenas
 * usa memoria y funciona igual en cualquier navegador. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Localiza los datos comprimidos de una entrada leyendo su cabecera local.
async function rawSlice(blob, offset, compressedSize) {
  const view = new DataView(await blob.slice(offset, offset + 30).arrayBuffer());
  if (view.getUint32(0, true) !== 0x04034b50) throw new Error("Cabecera ZIP no válida en la posición " + offset);
  const flags = view.getUint16(6, true);
  const method = view.getUint16(8, true);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  // Solo se conserva el campo extra de cifrado AES; el resto se puede omitir sin problema.
  let extra = new Uint8Array(0);
  if (flags & 1 && extraLength) {
    const raw = new Uint8Array(await blob.slice(offset + 30 + nameLength, offset + 30 + nameLength + extraLength).arrayBuffer());
    for (let i = 0; i + 4 <= raw.length; ) {
      const id = raw[i] | (raw[i + 1] << 8);
      const size = raw[i + 2] | (raw[i + 3] << 8);
      if (id === 0x9901) extra = raw.slice(i, i + 4 + size);
      i += 4 + size;
    }
  }
  const start = offset + 30 + nameLength + extraLength;
  return { blob: blob.slice(start, start + compressedSize), method, flags: flags & 1, extra };
}

// Convierte una entrada leída por zip.js en un elemento que se puede copiar tal cual.
function fromEntry(file, entry) {
  return {
    filename: entry.filename,
    directory: entry.directory,
    lastModDate: entry.lastModDate,
    signature: entry.signature,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    entry,
    raw: () => rawSlice(file, entry.offset, entry.compressedSize),
  };
}

// Elemento sin comprimir (texto o trozo de archivo) con su CRC calculado.
async function storedItem(filename, blob, lastModDate) {
  const signature = crc32(new Uint8Array(await blob.arrayBuffer()));
  return {
    filename,
    lastModDate,
    signature,
    compressedSize: blob.size,
    uncompressedSize: blob.size,
    raw: async () => ({ blob, method: 0, flags: 0, extra: new Uint8Array(0) }),
  };
}

async function buildZip(items) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const item of items) {
    const name = encoder.encode(item.filename);
    const { blob, method, flags, extra } = item.directory
      ? { blob: new Blob([]), method: 0, flags: 0, extra: new Uint8Array(0) }
      : await item.raw();
    if (blob.size >= 0xffffffff || offset >= 0xffffffff) throw new Error("Archivo de más de 4 GB no soportado");
    const { time, date } = dosDateTime(item.lastModDate);
    const version = extra.length ? 51 : 20;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, version, true);
    local.setUint16(6, flags | 0x0800, true); // 0x0800 = nombres en UTF-8
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, item.directory ? 0 : item.signature, true);
    local.setUint32(18, blob.size, true);
    local.setUint32(22, item.directory ? 0 : item.uncompressedSize, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, extra.length, true);
    chunks.push(local, name, extra, blob);

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, version, true);
    for (let i = 6; i < 32; i++) header.setUint8(i, local.getUint8(i - 2));
    header.setUint32(38, item.directory ? 0x10 : 0, true);
    header.setUint32(42, offset, true);
    central.push(header, name, extra);
    offset += 30 + name.length + extra.length + blob.size;
  }
  const centralSize = central.reduce((n, part) => n + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, items.length, true);
  end.setUint16(10, items.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], { type: "application/zip" });
}

// Construye un grupo y, si por lo que sea se pasara del límite, lo divide en dos.
async function buildGroup(items, limit, onDone) {
  const blob = await buildZip(items);
  if (blob.size <= limit || items.length === 1) {
    onDone(items);
    return [blob];
  }
  const half = Math.ceil(items.length / 2);
  return [
    ...(await buildGroup(items.slice(0, half), limit, onDone)),
    ...(await buildGroup(items.slice(half), limit, onDone)),
  ];
}

/* ---------- Archivos más grandes que el límite ---------- */

/* Destino que va guardando los datos en bloques de 8 MB, para no crear de golpe un único Blob
 * enorme a partir de un stream (en algunos navegadores eso falla). */
function chunkedSink() {
  const blobs = [];
  let buffer = [];
  let length = 0;
  const stream = new WritableStream({
    write(chunk) {
      buffer.push(chunk);
      length += chunk.length;
      if (length >= 8 * MB) {
        blobs.push(new Blob(buffer));
        buffer = [];
        length = 0;
      }
    },
    close() {
      if (length) blobs.push(new Blob(buffer));
    },
  });
  return { stream, blob: () => new Blob(blobs) };
}

// Si la descompresión se queda bloqueada, se abandona para pasar al siguiente método.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("La descompresión no avanza")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function decompress(entry, options) {
  const sink = chunkedSink();
  await withTimeout(entry.getData(sink.stream, options), 60000 + entry.uncompressedSize / 1000);
  const blob = sink.blob();
  if (blob.size !== entry.uncompressedSize) throw new Error("Tamaño descomprimido incorrecto");
  return blob;
}

// Comprime un trozo con zip.js y devuelve sus datos comprimidos listos para copiar.
async function compressedItem(filename, blob, lastModDate) {
  const writer = new ZipWriter(new BlobWriter(), { level: 6 });
  await writer.add("x", new BlobReader(blob), { lastModDate });
  const zipBlob = await writer.close();
  const [entry] = await new ZipReader(new BlobReader(zipBlob)).getEntries();
  return { ...fromEntry(zipBlob, entry), filename, lastModDate, directory: false };
}

async function pieceItem(filename, blob, compress, lastModDate) {
  if (compress) {
    try {
      const item = await compressedItem(filename, blob, lastModDate);
      if (item.compressedSize < blob.size) return item;
    } catch (err) {
      console.warn(err);
    }
  }
  return storedItem(filename, blob, lastModDate);
}

function joinInstructions(filename, joined, count, wrapped) {
  const name = joined.split("/").pop();
  const pieces = Array.from({ length: count }, (_, i) => `"${name}.${String(i + 1).padStart(3, "0")}"`);
  return [
    `El archivo "${filename}" pesaba más que el límite, así que se ha cortado en ${count} trozos`,
    `(${name}.001 ... ${name}.${String(count).padStart(3, "0")}), repartidos en varias partes.`,
    "",
    "Para recuperarlo: descomprime todas esas partes en la misma carpeta y luego une los trozos:",
    "",
    "Windows (Símbolo del sistema, dentro de la carpeta):",
    `  copy /b ${pieces.join(" + ")} "${name}"`,
    "",
    "Mac / Linux (Terminal, dentro de la carpeta):",
    `  cat ${pieces.join(" ")} > "${name}"`,
    "",
    ...(wrapped ? [`Después descomprime "${name}" y dentro tendrás "${filename.split("/").pop()}".`, ""] : []),
  ].join("\r\n");
}

/* Trocea un archivo enorme en piezas "nombre.001", "nombre.002"... Cada pieza se convierte en un
 * bloque más, así los trozos pequeños comparten parte con otros archivos en lugar de ocupar un
 * ZIP casi vacío. */
async function splitFile(item, budget, log, progress) {
  log(`Troceando ${item.filename} (${formatSize(item.uncompressedSize)})…`);
  const ext = item.filename.split(".").pop().toLowerCase();
  let compress = !COMPRESSED_EXT.has(ext);
  let joined = item.filename;
  let wrapped = false;
  let data;
  if (item.entry.compressionMethod === 0) {
    data = (await item.raw()).blob; // guardado sin comprimir: se usa tal cual
  } else {
    try {
      data = await decompress(item.entry);
    } catch (err) {
      console.warn(err);
      try {
        data = await decompress(item.entry, { useCompressionStream: false });
      } catch (err2) {
        console.warn(err2);
        // Último recurso: se trocea el archivo comprimido tal cual, metido en un .zip.
        log(`No se pudo descomprimir ${item.filename} en este navegador; se trocea comprimido.`);
        data = await buildZip([item]);
        joined = item.filename + ".zip";
        wrapped = true;
        compress = false;
      }
    }
  }
  const ratio = compress ? Math.max(item.compressedSize / Math.max(item.uncompressedSize, 1), 0.05) : 1;
  const overhead = entryOverhead(joined + ".000");
  const room = budget - README_RESERVE - overhead;
  const step = Math.max(64 * 1024, Math.floor(Math.min(room / ratio, room * 20) * 0.92));

  const ranges = [];
  for (let start = 0; start < data.size; start += step) ranges.push([start, Math.min(start + step, data.size)]);

  // Si algún trozo comprimido no cabe, se parte por la mitad hasta que quepa.
  const pieces = [];
  while (ranges.length) {
    const [start, end] = ranges.shift();
    const piece = await pieceItem("", data.slice(start, end), compress, item.lastModDate);
    if (piece.compressedSize + overhead + README_RESERVE > budget && end - start > 1024) {
      const mid = start + Math.floor((end - start) / 2);
      ranges.unshift([start, mid], [mid, end]);
    } else {
      pieces.push(piece);
      progress(`Troceando ${item.filename.split("/").pop()}: ${formatSize(end)} de ${formatSize(data.size)}`, end / data.size);
    }
  }

  const dir = item.filename.slice(0, item.filename.lastIndexOf("/") + 1);
  const readmeName = `${dir}COMO_UNIR_${item.filename.split("/").pop()}.txt`;
  const readme = await storedItem(
    readmeName,
    new Blob([encoder.encode(joinInstructions(item.filename, joined, pieces.length, wrapped))]),
    new Date(),
  );
  return pieces.map((piece, i) => {
    piece.filename = `${joined}.${String(i + 1).padStart(3, "0")}`;
    piece.piece = true;
    const items = i === 0 ? [piece, readme] : [piece];
    const size = piece.compressedSize + overhead + (i === 0 ? README_RESERVE : 0);
    return { entries: items, size };
  });
}

/* ---------- Interfaz ---------- */

const $ = (sel) => document.querySelector(sel);
const dropzone = $("#dropzone");
const fileInput = $("#file-input");
const limitInput = $("#limit");
const logBox = $("#log");
const results = $("#results");
const progressBar = $("#progress-bar");
const progressText = $("#progress-text");
const progressBox = $("#progress");
let saveDir = null;
let busy = false;

function log(text, kind = "") {
  const line = document.createElement("div");
  line.className = "log-line " + kind;
  line.textContent = text;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

function setProgress(done, total, label) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = pct + "%";
  progressText.textContent = `${label} · ${pct}%`;
}

function partName(base, index, total) {
  const width = Math.max(1, String(total).length);
  return `${base}_${String(index).padStart(width, "0")}.zip`;
}

async function deliver(blob, name, card) {
  const row = document.createElement("li");
  row.className = "part";
  const label = document.createElement("span");
  label.className = "part-name";
  label.textContent = name;
  const size = document.createElement("span");
  size.className = "part-size";
  size.textContent = formatSize(blob.size);
  row.append(label, size);
  if (saveDir) {
    const handle = await saveDir.getFileHandle(name, { create: true });
    const stream = await handle.createWritable();
    await stream.write(blob);
    await stream.close();
    const ok = document.createElement("span");
    ok.className = "part-saved";
    ok.textContent = "Guardado";
    row.append(ok);
  } else {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.className = "btn small";
    link.textContent = "Descargar";
    row.append(link);
  }
  card.querySelector("ul").append(row);
}

async function processFile(file, limit) {
  const base = file.name.replace(/\.zip$/i, "");
  const card = document.createElement("section");
  card.className = "card result";
  card.innerHTML = `<h3></h3><p class="summary">Leyendo…</p><ul class="parts"></ul>`;
  card.querySelector("h3").textContent = file.name;
  results.prepend(card);

  const reader = new ZipReader(new BlobReader(file));
  const entries = (await reader.getEntries()).map((entry) => fromEntry(file, entry));
  const fileEntries = entries.filter((e) => !e.directory);
  log(`${file.name}: ${fileEntries.length} archivos, ${formatSize(file.size)}.`);

  const budget = limit - ZIP_TAIL;
  const { units, oversize } = plan(entries, budget);
  const progress = (label, fraction) => setProgress(fraction, 1, label);
  for (const entry of oversize) units.push(...(await splitFile(entry, budget, log, progress)));
  const bins = packUnits(units, budget);

  const expected = bins.flatMap((bin) => bin.entries).filter((e) => !e.directory);
  const totalItems = bins.reduce((n, bin) => n + bin.entries.length, 0);
  const written = new Set();
  let done = 0;
  const onDone = (items) => {
    for (const item of items) if (!item.directory) written.add(item.filename);
    done += items.length;
    setProgress(done, totalItems, `Procesando ${file.name}`);
  };

  // Primero se generan todos los ZIP (para saber cuántos hay y numerarlos bien)…
  const blobs = [];
  for (const bin of bins) blobs.push(...(await buildGroup(bin.entries, limit, onDone)));
  await reader.close();

  const total = blobs.length;
  // …y luego se entregan, liberando memoria a medida que se guardan en la carpeta.
  for (let i = 0; i < total; i++) {
    await deliver(blobs[i], partName(base, i + 1, total), card);
    if (saveDir) blobs[i] = null;
  }

  // Comprobación final: cada archivo del ZIP original (o cada trozo suyo) está en alguna parte.
  const originalsDone = new Set(fileEntries.map((e) => e.filename).filter((name) => written.has(name)));
  for (const e of oversize) {
    const pieces = expected.filter((x) => x.piece && x.filename.startsWith(e.filename + "."));
    if (pieces.every((x) => written.has(x.filename))) originalsDone.add(e.filename);
  }
  const splitCount = oversize.length;
  const missing = fileEntries.filter((e) => !originalsDone.has(e.filename));
  const summary = card.querySelector(".summary");
  summary.textContent =
    `${total} parte${total === 1 ? "" : "s"} · ${originalsDone.size} de ${fileEntries.length} archivos incluidos` +
    (missing.length ? ` · FALTAN ${missing.length}` : " ✔") +
    (splitCount ? ` · ${splitCount} archivo(s) muy grande(s) troceado(s), ver COMO_UNIR_*.txt` : "");
  summary.classList.toggle("bad", missing.length > 0);

  if (!saveDir && total > 1) {
    const all = document.createElement("button");
    all.className = "btn";
    all.textContent = "Descargar todas";
    all.onclick = async () => {
      for (const link of card.querySelectorAll("a[download]")) {
        link.click();
        await new Promise((r) => setTimeout(r, 400));
      }
    };
    card.insertBefore(all, card.querySelector("ul"));
  }
  log(`${file.name}: listo, ${total} parte(s).`, missing.length ? "bad" : "ok");
}

function errorText(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return String(err ?? "error desconocido");
  } catch (_) {
    return "error desconocido";
  }
}

// Cualquier error que se escape también se muestra, para que nunca falle en silencio.
window.addEventListener("unhandledrejection", (e) => log(`Error inesperado — ${errorText(e.reason)}`, "bad"));
window.addEventListener("error", (e) => log(`Error inesperado — ${errorText(e.error || e.message)}`, "bad"));

async function handleFiles(files) {
  if (busy) return;
  const zips = [...files].filter((f) => /\.zip$/i.test(f.name));
  if (!zips.length) {
    log("Selecciona uno o varios archivos .zip.", "bad");
    return;
  }
  const limit = Math.floor(parseFloat(String(limitInput.value).replace(",", ".")) * MB);
  if (!(limit >= 1 * MB)) {
    log("El tamaño máximo debe ser de al menos 1 MB.", "bad");
    return;
  }
  busy = true;
  dropzone.classList.add("busy");
  progressBox.hidden = false;
  try {
    for (const file of zips) {
      try {
        await processFile(file, limit);
      } catch (err) {
        console.error(err);
        const message = errorText(err);
        log(`${file.name}: error — ${message}`, "bad");
        if (/NotReadable|ERRORED|read/i.test(message)) {
          log("Consejo: si el ZIP está en una nube (Drive, OneDrive, iCloud…) o en el móvil, cópialo primero " +
            "a una carpeta normal del ordenador y vuelve a intentarlo, mejor en Chrome o Edge.", "bad");
        }
      }
    }
  } finally {
    busy = false;
    dropzone.classList.remove("busy");
    progressText.textContent = "Terminado";
    progressBar.style.width = "100%";
  }
}

dropzone.addEventListener("click", () => !busy && fileInput.click());
dropzone.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && !busy && fileInput.click());
fileInput.addEventListener("change", () => {
  handleFiles(fileInput.files);
  fileInput.value = "";
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("over");
  handleFiles(e.dataTransfer.files);
});

const folderBtn = $("#pick-folder");
if ("showDirectoryPicker" in window) {
  folderBtn.addEventListener("click", async () => {
    try {
      saveDir = await window.showDirectoryPicker({ mode: "readwrite" });
      $("#folder-name").textContent = `Se guardarán en: ${saveDir.name}`;
    } catch (_) {
      /* cancelado */
    }
  });
} else {
  folderBtn.hidden = true;
}

// Expuesto para pruebas automáticas.
window.__splitter = { plan, handleFiles };
