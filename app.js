/* Divisor de ZIP: reparte el contenido de un ZIP grande en varios ZIP de como máximo N MB.
 * Todo ocurre en el navegador: los archivos nunca salen del ordenador. */
"use strict";

const { ZipReader, ZipWriter, BlobReader, BlobWriter, TextReader, configure } = zip;
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

/* ---------- Archivos más grandes que el límite ---------- */

function joinInstructions(filename, count) {
  const name = filename.split("/").pop();
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
  ].join("\r\n");
}

/* Trocea un archivo enorme en piezas "nombre.001", "nombre.002"... Cada pieza se comprime una
 * sola vez y se convierte en un bloque más, así los trozos pequeños comparten parte con otros
 * archivos en lugar de ocupar un ZIP casi vacío. */
async function splitFile(entry, budget, log) {
  log(`Troceando ${entry.filename} (${formatSize(entry.uncompressedSize)})…`);
  const data = await entry.getData(new BlobWriter());
  const ext = entry.filename.split(".").pop().toLowerCase();
  const level = COMPRESSED_EXT.has(ext) ? 0 : 6;
  const ratio = level ? Math.max(entry.compressedSize / Math.max(entry.uncompressedSize, 1), 0.05) : 1;
  const overhead = entryOverhead(entry.filename + ".000");
  const room = budget - README_RESERVE - overhead;
  const step = Math.max(64 * 1024, Math.floor((room / ratio) * 0.92));

  const ranges = [];
  for (let start = 0; start < data.size; start += step) ranges.push([start, Math.min(start + step, data.size)]);

  // Comprime cada trozo y, si alguno no cabe, lo parte por la mitad hasta que quepa.
  const pieces = [];
  while (ranges.length) {
    const [start, end] = ranges.shift();
    const writer = new ZipWriter(new BlobWriter(), { level });
    await writer.add("x", new BlobReader(data.slice(start, end)), { lastModDate: entry.lastModDate });
    const [compressed] = await new ZipReader(new BlobReader(await writer.close())).getEntries();
    if (compressed.compressedSize + overhead + README_RESERVE > budget && end - start > 1024) {
      const mid = start + Math.floor((end - start) / 2);
      ranges.unshift([start, mid], [mid, end]);
    } else {
      pieces.push(compressed);
    }
  }

  const dir = entry.filename.slice(0, entry.filename.lastIndexOf("/") + 1);
  const readmeName = `${dir}COMO_UNIR_${entry.filename.split("/").pop()}.txt`;
  const readme = joinInstructions(entry.filename, pieces.length);
  return pieces.map((src, i) => {
    const filename = `${entry.filename}.${String(i + 1).padStart(3, "0")}`;
    const items = [{ filename, src, lastModDate: entry.lastModDate }];
    if (i === 0) items.push({ filename: readmeName, text: readme });
    const size = src.compressedSize + overhead + (i === 0 ? README_RESERVE : 0);
    return { entries: items, size };
  });
}

/* ---------- Escritura de los ZIP ---------- */

// Copia las entradas sin descomprimirlas ni recomprimirlas: rápido y sin pérdida.
async function writeGroup(items) {
  const writer = new ZipWriter(new BlobWriter("application/zip"), { keepOrder: true });
  for (const item of items) {
    if (item.text !== undefined) {
      await writer.add(item.filename, new TextReader(item.text));
    } else if (item.directory) {
      await writer.add(item.filename, null, { directory: true, lastModDate: item.lastModDate });
    } else {
      const src = item.src || item;
      const raw = await src.getData(new BlobWriter(), { passThrough: true });
      await writer.add(item.filename, new BlobReader(raw), {
        passThrough: true,
        encrypted: src.encrypted,
        uncompressedSize: src.uncompressedSize,
        signature: src.signature,
        compressionMethod: src.compressionMethod,
        lastModDate: item.lastModDate,
      });
    }
  }
  return writer.close();
}

// Construye un grupo y, si por lo que sea se pasara del límite, lo divide en dos.
async function buildGroup(items, limit, onDone) {
  const blob = await writeGroup(items);
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
  const entries = await reader.getEntries();
  const fileEntries = entries.filter((e) => !e.directory);
  log(`${file.name}: ${fileEntries.length} archivos, ${formatSize(file.size)}.`);

  const budget = limit - ZIP_TAIL;
  const { units, oversize } = plan(entries, budget);
  for (const entry of oversize) units.push(...(await splitFile(entry, budget, log)));
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
    const pieces = expected.filter((x) => x.src && x.filename.startsWith(e.filename + "."));
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
        log(`${file.name}: error — ${err.message || err}`, "bad");
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
