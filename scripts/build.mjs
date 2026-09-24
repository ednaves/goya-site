// Gera a versão publicada do site em _site/
//  - uma página própria para cada projeto (projetos/<nome>/), com título, descrição e prévia para Google/WhatsApp
//  - fotos reduzidas para no máximo 2000 px e miniaturas dos cards (imagens/_cards/)
//  - sitemap.xml e robots.txt
// Roda sozinho no GitHub a cada alteração (.github/workflows/publicar.yml).
// Local: SITE_URL=http://localhost:4817/ node scripts/build.mjs

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const RAIZ = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SAIDA = path.join(RAIZ, "_site");
const SITE_URL = (process.env.SITE_URL || "http://localhost:4817/").replace(/\/?$/, "/");
const BASE = new URL(SITE_URL).pathname;               // ex.: /goya-site/ ou /
const IGNORAR = new Set(["_site", "node_modules", "scripts", ".git", ".github", ".claude", ".pages.yml",
  "package.json", "package-lock.json", ".gitignore", ".DS_Store"]);

const MAX_FOTO = 2000;                                   // lado maior das fotos publicadas
const CARD = { width: 720, height: 900 };                // card 4:5 — nítido até em tela Retina
const OG = { width: 1200, height: 630 };                 // prévia de link (WhatsApp, Facebook, LinkedIn)

const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slugify = t => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const rel = src => String(src || "").replace(/^\//, "");
const ehFoto = f => /\.(jpe?g|png|webp)$/i.test(f);

async function* arquivos(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (IGNORAR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* arquivos(p); else yield p;
  }
}

// ---------- 1. Copia o site, reduzindo fotos grandes ----------
await fs.rm(SAIDA, { recursive: true, force: true });
let reduzidas = 0, copiadas = 0;
for await (const orig of arquivos(RAIZ)) {
  const r = path.relative(RAIZ, orig), dest = path.join(SAIDA, r);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (r.startsWith("imagens" + path.sep) && ehFoto(r)) {
    const img = sharp(orig).rotate();                    // respeita a orientação da câmera
    const { width = 0, height = 0 } = await img.metadata();
    const { size } = await fs.stat(orig);
    if (Math.max(width, height) > MAX_FOTO || size > 1.2e6) {
      const saida = img.resize({ width: MAX_FOTO, height: MAX_FOTO, fit: "inside", withoutEnlargement: true });
      await (/\.png$/i.test(r) ? saida.png({ compressionLevel: 9 }) : saida.jpeg({ quality: 82, mozjpeg: true })).toFile(dest);
      reduzidas++;
      continue;
    }
  }
  await fs.copyFile(orig, dest);
  copiadas++;
}

// ---------- 2. Dados ----------
const lerJson = async f => JSON.parse(await fs.readFile(path.join(RAIZ, f), "utf8"));
const usados = new Set();
const projetos = ((await lerJson("content/projetos.json")).projetos || []).filter(p => p && p.nome).map(p => {
  let slug = slugify(p.nome), n = 2;
  while (usados.has(slug)) slug = slugify(p.nome) + "-" + n++;
  usados.add(slug);
  return { ...p, slug, capa: rel(p.capa || (p.fotos || [])[0]), fotos: (p.fotos || []).filter(Boolean).map(rel) };
});

// ---------- 3. Miniaturas dos cards e imagens de prévia ----------
const fotoPublicada = r => path.join(SAIDA, r);
async function gera(r, destRel, tam) {
  const origem = fotoPublicada(r);
  try { await fs.access(origem); } catch { console.warn(`  ! foto não encontrada: ${r}`); return false; }
  const dest = path.join(SAIDA, destRel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await sharp(origem).rotate().resize({ ...tam, fit: tam === CARD ? "outside" : "cover", withoutEnlargement: tam === CARD })
    .jpeg({ quality: 80, mozjpeg: true }).toFile(dest);
  return true;
}
let cards = 0;
for (const p of projetos) {
  if (!p.capa) continue;
  // mesma pasta e nome da foto original, dentro de imagens/_cards/ (o site procura ali)
  const cardRel = p.capa.replace(/^imagens\//, "imagens/_cards/");
  if (await gera(p.capa, cardRel, CARD)) cards++;
  p.og = (await gera(p.capa, `imagens/_og/${p.slug}.jpg`, OG)) ? `imagens/_og/${p.slug}.jpg` : null;
}
const aberturaOg = (await gera("imagens/site/abertura.jpg", "imagens/_og/site.jpg", OG)) ? "imagens/_og/site.jpg" : null;

// ---------- 4. Páginas ----------
const modelo = await fs.readFile(path.join(RAIZ, "index.html"), "utf8");
const DESCRICAO = "Goya Arquitetura: projeto, construção e consultoria em taipa de pilão e arquitetura com terra.";

function seo({ titulo, descricao, url, imagem }) {
  return [
    `<title>${esc(titulo)}</title>`,
    `<meta name="description" content="${esc(descricao)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Goya Arquitetura">`,
    `<meta property="og:locale" content="pt_BR">`,
    `<meta property="og:title" content="${esc(titulo)}">`,
    `<meta property="og:description" content="${esc(descricao)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    imagem && `<meta property="og:image" content="${esc(SITE_URL + imagem)}">`,
    imagem && `<meta property="og:image:width" content="${OG.width}"><meta property="og:image:height" content="${OG.height}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].filter(Boolean).join("\n");
}
const montaPagina = (cabecalho, extra = h => h) =>
  extra(modelo
    .replace("<!--BASE-->", `<base href="${BASE}">`)
    .replace(/<!--SEO:inicio-->[\s\S]*?<!--SEO:fim-->/, cabecalho));

// Página inicial
await fs.writeFile(path.join(SAIDA, "index.html"),
  montaPagina(seo({ titulo: "Goya Arquitetura — arquitetura em terra e taipa de pilão", descricao: DESCRICAO, url: SITE_URL, imagem: aberturaOg })));

// Uma página por projeto. O conteúdo já vem escrito no HTML (Google lê mesmo sem rodar o JavaScript);
// no navegador, o JavaScript monta a mesma página com as animações e a galeria.
for (const p of projetos) {
  const url = `${SITE_URL}projetos/${p.slug}/`;
  const descricao = p.resumo || p.destaque || DESCRICAO;
  const paragrafos = String(p.memoria || "").split(/\n\s*\n/).map(t => t.trim()).filter(Boolean);
  const estatico = `<section id="projeto">
    <div class="d-head"><a href="#projetos" class="back">← Projetos</a><h1 class="title">${esc(p.nome)}</h1></div>
    ${p.capa ? `<div class="d-hero"><img src="${esc(p.capa)}" alt="${esc(p.nome)}"></div>` : ""}
    <div class="d-info"><div class="d-mem"><span class="eyebrow">Memória do projeto</span>
      ${p.destaque ? `<p class="d-lead">${esc(p.destaque)}</p>` : ""}
      ${paragrafos.map(t => `<p>${esc(t)}</p>`).join("\n      ")}</div>
      <div class="d-ficha"><span class="eyebrow">Ficha técnica</span><dl>
        ${(p.ficha || []).filter(f => f && f.rotulo).map(f => `<div><dt>${esc(f.rotulo)}</dt><dd>${esc(f.valor)}</dd></div>`).join("")}
      </dl></div></div>
  </section>`;
  const html = montaPagina(
    seo({ titulo: `${p.nome} | Goya Arquitetura`, descricao, url, imagem: p.og }),
    h => h.replace("<body>", `<body class="detail">`).replace('<section id="projeto"></section>', estatico));
  await fs.mkdir(path.join(SAIDA, "projetos", p.slug), { recursive: true });
  await fs.writeFile(path.join(SAIDA, "projetos", p.slug, "index.html"), html);
}

// Endereço inexistente: volta para o início
await fs.writeFile(path.join(SAIDA, "404.html"),
  `<!DOCTYPE html><meta charset="utf-8"><title>Goya Arquitetura</title><meta http-equiv="refresh" content="0; url=${BASE}"><a href="${BASE}">Goya Arquitetura</a>`);

// ---------- 5. Sitemap e robots ----------
const hoje = new Date().toISOString().slice(0, 10);
await fs.writeFile(path.join(SAIDA, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  [SITE_URL, ...projetos.map(p => `${SITE_URL}projetos/${p.slug}/`)]
    .map(u => `  <url><loc>${esc(u)}</loc><lastmod>${hoje}</lastmod></url>`).join("\n") + `\n</urlset>\n`);
await fs.writeFile(path.join(SAIDA, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`);

console.log(`✓ ${projetos.length} páginas de projeto · ${cards} miniaturas · ${reduzidas} fotos reduzidas · ${copiadas} arquivos copiados`);
console.log(`  endereço: ${SITE_URL}`);
