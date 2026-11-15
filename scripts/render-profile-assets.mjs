import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  siCplusplus,
  siExpress,
  siGit,
  siGithub,
  siJavascript,
  siLaravel,
  siMysql,
  siNodedotjs,
  siPhp,
  siPostgresql,
  siReact,
  siSqlite,
  siTypescript,
} from "simple-icons";
import { renderPlaceholderSvg } from "./generate-github-analytics.mjs";
import { rasterizeSvg } from "./rasterize-svg.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONT = "Segoe UI, DejaVu Sans, sans-serif";

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function svgDoc(width, height, body, transparent = false) {
  const background = transparent ? "" : `<rect width="${width}" height="${height}" fill="#0D0A10"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${background}
  ${body}
</svg>`;
}

async function writeSvgPng(svg, width, dest) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const png = rasterizeSvg(svg, width);
  await sharp(png).png({ compressionLevel: 9 }).toFile(dest);
}

function iconMark(icon, x, y, size) {
  const hex = (icon.hex || "F5F0F2").toUpperCase();
  const color = hex === "000000" || hex === "FFFFFF" ? "#F5F0F2" : `#${hex}`;
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24"><path fill="${color}" d="${icon.path}"/></svg>`;
}

function wrap(text, maxChars) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function pills(labels, x, y, maxWidth) {
  const rows = [];
  let row = [];
  let used = 0;
  for (const label of labels) {
    const width = Math.max(58, Math.round(label.length * 7.4 + 24));
    if (used + width > maxWidth && row.length) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push({ label, width });
    used += width + 8;
  }
  if (row.length) rows.push(row);
  return rows.map((items, rowIndex) => {
    let cursor = x;
    const top = y + rowIndex * 34;
    return items.map(({ label, width }) => {
      const node = `<rect x="${cursor}" y="${top}" width="${width}" height="26" rx="13" fill="#24141C" stroke="#43202F"/>
        <text x="${cursor + width / 2}" y="${top + 17}" text-anchor="middle" fill="#F5F0F2" font-family="${FONT}" font-size="12">${esc(label)}</text>`;
      cursor += width + 8;
      return node;
    }).join("");
  }).join("");
}

function linkMark(x, y) {
  return `<path d="M${x} ${y + 4}h7v7M${x + 7} ${y + 4}L${x} ${y + 11}" fill="none" stroke="#EF355D" stroke-width="1.6" stroke-linecap="round"/>`;
}

async function coverUri(file, width, height, position = "centre") {
  const buffer = await sharp(file).resize(width, height, { fit: "cover", position }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function floraArt(x, y, width, height) {
  const boardX = x + width / 2 - 78;
  const boardY = y + height / 2 - 48;
  const pins = Array.from({ length: 8 }, (_, index) => {
    const py = boardY + 14 + index * 9;
    return `<rect x="${boardX - 10}" y="${py}" width="10" height="4" rx="1" fill="#8F1D3F"/>
      <rect x="${boardX + 146}" y="${py}" width="10" height="4" rx="1" fill="#8F1D3F"/>`;
  }).join("");
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="16" fill="#120E14" stroke="#43202F"/>
    <path d="M${x + 54} ${y + height - 36}c18-28 28-44 18-62-16 6-28 24-32 40 10 4 16 12 14 22z" fill="#243028" stroke="#8F1D3F"/>
    <circle cx="${x + width - 70}" cy="${y + 58}" r="18" fill="none" stroke="#EF355D" stroke-width="2"/>
    <path d="M${x + width - 70} ${y + 46}v24M${x + width - 82} ${y + 58}h24" stroke="#F28BA3" stroke-width="1.5"/>
    <rect x="${boardX}" y="${boardY}" width="156" height="96" rx="12" fill="#1B1018" stroke="#EF355D" stroke-width="2"/>
    ${pins}
    <text x="${x + width / 2}" y="${boardY + 56}" text-anchor="middle" fill="#F5F0F2" font-family="${FONT}" font-size="20" font-weight="700">ESP32</text>`;
}

function projectCard({ width, height, shot, title, description, labels, note, shotRatio = 0.48 }) {
  const pad = 18;
  const shotH = Math.round(height * shotRatio);
  const textX = pad + 8;
  const titleY = pad + shotH + 42;
  const lines = wrap(description, width > 700 ? 78 : 42);
  const body = lines.map((line, index) => (
    `<text x="${textX}" y="${titleY + 36 + index * 24}" fill="#B7AAB1" font-family="${FONT}" font-size="16">${esc(line)}</text>`
  )).join("");
  const noteY = titleY + 36 + lines.length * 24 + 8;
  const noteText = note
    ? `<text x="${textX}" y="${noteY}" fill="#8C7B84" font-family="${FONT}" font-size="13">${esc(note)}</text>`
    : "";
  const pillY = (note ? noteY + 16 : titleY + 28 + lines.length * 24) + 8;
  const image = shot
    ? `<clipPath id="shot"><rect x="${pad}" y="${pad}" width="${width - pad * 2}" height="${shotH}" rx="16"/></clipPath>
       <image href="${shot}" x="${pad}" y="${pad}" width="${width - pad * 2}" height="${shotH}" clip-path="url(#shot)" preserveAspectRatio="xMidYMid slice"/>`
    : floraArt(pad, pad, width - pad * 2, shotH);
  return svgDoc(width, height, `
    <rect x="8" y="8" width="${width - 16}" height="${height - 16}" rx="22" fill="#1B1018" stroke="#43202F" stroke-width="2"/>
    ${image}
    <text x="${textX}" y="${titleY}" fill="#F5F0F2" font-family="${FONT}" font-size="26" font-weight="700">${esc(title)}</text>
    ${linkMark(textX + title.length * 15 + 16, titleY - 16)}
    ${body}
    ${noteText}
    ${pills(labels, textX, pillY, width - textX - 28)}
  `);
}

function techTile(icon, label, x, y) {
  return `<rect x="${x}" y="${y}" width="118" height="78" rx="16" fill="#24141C" stroke="#43202F"/>
    ${iconMark(icon, x + 45, y + 12, 28)}
    <text x="${x + 59}" y="${y + 62}" text-anchor="middle" fill="#B7AAB1" font-family="${FONT}" font-size="12">${esc(label)}</text>`;
}

async function renderHero() {
  const width = 1920;
  const height = 640;
  const photo = await sharp(path.join(root, "assets", "source", "hero-workspace.jpg"))
    .resize(width, height, { fit: "cover", position: "right" })
    .png()
    .toBuffer();
  const overlay = rasterizeSvg(svgDoc(width, height, `
    <defs>
      <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#0D0A10"/>
        <stop offset="0.46" stop-color="#0D0A10" stop-opacity="0.82"/>
        <stop offset="0.72" stop-color="#0D0A10" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="name" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#EF355D"/>
        <stop offset="1" stop-color="#F28BA3"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#shade)"/>
    <polygon points="0,0 260,0 0,48" fill="#EF355D"/>
    <circle cx="64" cy="92" r="7" fill="#EF355D"/>
    <circle cx="88" cy="92" r="7" fill="#F28BA3"/>
    <circle cx="112" cy="92" r="7" fill="#8F1D3F"/>
    <text x="64" y="168" fill="#EF355D" font-family="${FONT}" font-size="28">&gt; hello, I'm</text>
    <text x="64" y="268" font-family="${FONT}" font-size="84" font-weight="700">
      <tspan fill="#F5F0F2">Roshel </tspan>
      <tspan fill="url(#name)">Peter</tspan>
    </text>
    <text x="64" y="328" fill="#F5F0F2" font-family="${FONT}" font-size="30">Computer Science Undergraduate</text>
    <rect x="64" y="358" width="4" height="28" rx="2" fill="#EF355D"/>
    <text x="84" y="380" fill="#B7AAB1" font-family="${FONT}" font-size="22">Software Engineering &amp; Full-Stack Development</text>
  `, true), width);
  await sharp(photo).composite([{ input: overlay, top: 0, left: 0 }]).png({ compressionLevel: 9 }).toFile(path.join(root, "assets", "profile", "hero.png"));
}

function pinIcon(cx, cy) {
  return `<path d="M${cx} ${cy - 8}a4 4 0 0 0-4 4c0 3 4 7 4 7s4-4 4-7a4 4 0 0 0-4-4z" fill="none" stroke="#EF355D" stroke-width="1.4"/>
    <circle cx="${cx}" cy="${cy - 4}" r="1.3" fill="#EF355D"/>`;
}

function capIcon(cx, cy) {
  return `<path d="M${cx} ${cy - 7}l8 3.5-8 3.5-8-3.5zM${cx - 5} ${cy - 1}v4.5c1.6 1.6 8.4 1.6 10 0V${cy - 1}" fill="none" stroke="#EF355D" stroke-width="1.3" stroke-linejoin="round"/>`;
}

function focusIcon(cx, cy) {
  return `<rect x="${cx - 6}" y="${cy - 5}" width="12" height="9" rx="1.5" fill="none" stroke="#EF355D" stroke-width="1.3"/>
    <path d="M${cx - 3} ${cy - 5}v-2h6v2" fill="none" stroke="#EF355D" stroke-width="1.3"/>`;
}

async function renderAbout() {
  const icons = [
    [siReact, "React"],
    [siTypescript, "TypeScript"],
    [siJavascript, "JavaScript"],
    [siNodedotjs, "Node.js"],
    [siExpress, "Express"],
    [siPhp, "PHP"],
    [siLaravel, "Laravel"],
    [siPostgresql, "PostgreSQL"],
    [siMysql, "MySQL"],
    [siSqlite, "SQLite"],
    [siCplusplus, "C++"],
    [siGit, "Git"],
  ];
  const tiles = icons.map(([icon, label], index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    return techTile(icon, label, 1348 + column * 136, 108 + row * 92);
  }).join("");
  const paragraph = wrap("Computer Science undergraduate at APIIT Sri Lanka, interested in software engineering and full-stack development. I enjoy designing and building practical, scalable applications.", 46);
  const lines = paragraph.map((line, index) => (
    `<text x="56" y="${132 + index * 30}" fill="#B7AAB1" font-family="${FONT}" font-size="20">${esc(line)}</text>`
  )).join("");
  const facts = [
    ["Location", ["Sri Lanka"], pinIcon(700, 122)],
    ["Education", ["Computer Science, APIIT Sri Lanka"], capIcon(700, 200)],
    ["Focus", ["Software engineering", "and full-stack development"], focusIcon(700, 278)],
  ].map(([label, lines, icon]) => {
    const blockY = label === "Location" ? 122 : label === "Education" ? 200 : 278;
    return `<circle cx="700" cy="${blockY}" r="16" fill="#24141C" stroke="#EF355D"/>
      ${icon}
      <text x="732" y="${blockY - 8}" fill="#F28BA3" font-family="${FONT}" font-size="14">${esc(label)}</text>
      ${lines.map((line, index) => `<text x="732" y="${blockY + 16 + index * 22}" fill="#F5F0F2" font-family="${FONT}" font-size="18">${esc(line)}</text>`).join("")}`;
  }).join("");
  const svg = svgDoc(1920, 430, `
    <text x="56" y="64" fill="#F5F0F2" font-family="${FONT}" font-size="32" font-weight="700">About Me</text>
    <rect x="56" y="78" width="84" height="3" fill="#EF355D"/>
    ${lines}
    ${facts}
    <text x="1348" y="64" fill="#F5F0F2" font-family="${FONT}" font-size="32" font-weight="700">Tech Stack</text>
    <rect x="1348" y="78" width="92" height="3" fill="#EF355D"/>
    ${tiles}
  `);
  await writeSvgPng(svg, 1920, path.join(root, "assets", "profile", "about-tech.png"));
}

async function renderHeading() {
  const svg = svgDoc(1920, 88, `
    <text x="48" y="54" fill="#EF355D" font-family="${FONT}" font-size="28" font-weight="700">&lt;/&gt;</text>
    <text x="112" y="54" fill="#F5F0F2" font-family="${FONT}" font-size="32" font-weight="700">Featured Projects</text>
    <text x="1640" y="54" fill="#F28BA3" font-family="${FONT}" font-size="20">View all repositories →</text>
  `);
  await writeSvgPng(svg, 1920, path.join(root, "assets", "profile", "projects-heading.png"));
}

async function renderProjects() {
  const shots = {
    renovahub: path.join(root, "assets", "project-screenshots", "renovahub-homepage.png"),
    performx: path.join(root, "assets", "project-screenshots", "performx-homepage.png"),
    eventra: path.join(root, "assets", "project-screenshots", "eventra-events.png"),
    notely: path.join(root, "assets", "project-screenshots", "notely-home.jpg"),
    greenbite: path.join(root, "assets", "project-screenshots", "greenbite-homepage.png"),
  };
  const large = [
    {
      file: "renovahub.png",
      title: "RenovaHub",
      shot: await coverUri(shots.renovahub, 1500, 520, "north"),
      description: "Collaborative renovation project management platform for homeowners, designers and contractors.",
      labels: ["Laravel", "PHP", "Livewire", "MySQL"],
    },
    {
      file: "performx-360.png",
      title: "PerformX 360",
      shot: await coverUri(shots.performx, 1500, 520),
      description: "Role-based employee performance management system with PDP, evaluations, reviews and recognition.",
      labels: ["React", "TypeScript", "Express", "PostgreSQL"],
    },
  ];
  const small = [
    {
      file: "eventra.png",
      title: "Eventra",
      shot: await coverUri(shots.eventra, 860, 400),
      description: "Full-stack event registration and ticket management platform.",
      labels: ["React", "Node.js", "SQLite"],
    },
    {
      file: "notely.png",
      title: "Notely",
      shot: await coverUri(shots.notely, 860, 400),
      description: "Personal knowledge management workspace for notes, tasks and ideas.",
      labels: ["React", "TypeScript", "Express"],
    },
    {
      file: "floraguard.png",
      title: "FloraGuard",
      shot: null,
      description: "ESP32 nursery microclimate controller with environmental monitoring and automation.",
      note: "Circuit screenshots are not in the repository yet.",
      labels: ["C++", "ESP32", "IoT"],
    },
    {
      file: "greenbite.png",
      title: "GreenBite",
      shot: await coverUri(shots.greenbite, 860, 400),
      description: "Interactive health and wellness website with recipes, nutrition and workout tools.",
      labels: ["HTML", "CSS", "JavaScript"],
    },
  ];
  for (const card of large) {
    const svg = projectCard({ width: 960, height: 520, shotRatio: 0.5, ...card });
    await writeSvgPng(svg, 960, path.join(root, "assets", "projects", card.file));
  }
  for (const card of small) {
    const svg = projectCard({ width: 480, height: 490, shotRatio: 0.42, ...card });
    await writeSvgPng(svg, 480, path.join(root, "assets", "projects", card.file));
  }
}

async function renderFooter() {
  const svg = svgDoc(1920, 210, `
    <text x="56" y="78" fill="#F5F0F2" font-family="${FONT}" font-size="30" font-weight="700">Let's Connect</text>
    <rect x="300" y="46" width="168" height="44" rx="22" fill="#1B1018" stroke="#EF355D" stroke-width="2"/>
    ${iconMark(siGithub, 318, 56, 24)}
    <text x="352" y="75" fill="#F5F0F2" font-family="${FONT}" font-size="18">GitHub</text>
    <text x="1780" y="78" fill="#EF355D" font-family="${FONT}" font-size="28">&lt;/&gt;</text>
    <path d="M0 150 L120 118 L210 138 L320 96 L430 132 L540 88 L660 128 L790 84 L920 126 L1040 90 L1160 130 L1280 96 L1400 128 L1520 100 L1640 132 L1760 108 L1920 126 L1920 210 L0 210 Z" fill="#140910" stroke="#EF355D" stroke-width="2"/>
    <path d="M0 168 L150 142 L280 156 L420 130 L560 158 L700 136 L860 160 L1020 138 L1180 162 L1340 140 L1500 164 L1680 146 L1920 158" fill="none" stroke="#8F1D3F" stroke-width="2"/>
  `);
  await writeSvgPng(svg, 1920, path.join(root, "assets", "profile", "footer.png"));
}

async function renderAnalyticsPlaceholder() {
  const dest = path.join(root, "assets", "profile", "analytics.png");
  const force = process.argv.includes("--placeholder");
  if (existsSync(dest) && !force) return;
  await writeSvgPng(renderPlaceholderSvg(), 1600, dest);
}

await renderHero();
await renderAbout();
await renderHeading();
await renderProjects();
await renderFooter();
await renderAnalyticsPlaceholder();
console.log("Profile panels written.");
