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
// Endereço público do site. No GitHub vem do workflow; no Cloudflare Pages, da variável SITE_URL
// (ou do endereço automático da publicação, CF_PAGES_URL, nas prévias).
const SITE_URL = (process.env.SITE_URL || process.env.CF_PAGES_URL || "http://localhost:4817/").replace(/\/?$/, "/");
// NOINDEX=1: esconde esta cópia do Google (útil para ter duas hospedagens no ar sem conteúdo duplicado)
const NOINDEX = /^(1|true|sim)$/i.test(process.env.NOINDEX || "");
const BASE = new URL(SITE_URL).pathname;               // ex.: /goya-site/ ou /
const IGNORAR = new Set(["_site", "node_modules", "scripts", ".git", ".github", ".claude", ".pages.yml",
  "package.json", "package-lock.json", ".gitignore", ".DS_Store"]);

const MAX_FOTO = 2800;                                   // lado maior das fotos publicadas (nítido em telas grandes Retina)
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
    if (Math.max(width, height) > MAX_FOTO || size > 3e6) {
      const saida = img.resize({ width: MAX_FOTO, height: MAX_FOTO, fit: "inside", withoutEnlargement: true });
      await (/\.png$/i.test(r) ? saida.png({ compressionLevel: 9 }) : saida.jpeg({ quality: 86, mozjpeg: true })).toFile(dest);
      reduzidas++;
      continue;
    }
  }
  await fs.copyFile(orig, dest);
  copiadas++;
}

// ---------- 2. Dados ----------
const lerJson = async f => JSON.parse(await fs.readFile(path.join(RAIZ, f), "utf8"));
// Códigos das ferramentas externas (Search Console, Umami, Clarity). Vazios = ferramenta desligada.
const INTEG = await lerJson("content/integracoes.json").catch(() => ({}));
// Dados do escritório para o Google (dados estruturados Schema.org)
const ESCRITORIO = {
  nome: "Goya Arquitetura",
  telefone: "+55 19 99615-3063",
  email: "goya@goyarq.com.br",
  endereco: { rua: "Rua Formosa, 51", bairro: "Centro Histórico", cidade: "São Paulo", estado: "SP", pais: "BR" },
  instagram: "https://www.instagram.com/goya.terra/",
  fundador: "Rodrigo Rocha",
};
const usados = new Set();
const projetos = ((await lerJson("content/projetos.json")).projetos || []).filter(p => p && p.nome).map(p => {
  let slug = slugify(p.nome), n = 2;
  while (usados.has(slug)) slug = slugify(p.nome) + "-" + n++;
  usados.add(slug);
  return { ...p, slug, capa: rel(p.capa || (p.fotos || [])[0]), topo: rel(p.topo), fotos: (p.fotos || []).filter(Boolean).map(rel) };
});

// ---------- 2b. Foto do topo da página de cada projeto ----------
// O topo mostra a foto num retângulo horizontal grande. Se o cliente não escolheu uma (campo "topo"),
// usa a capa quando ela é horizontal e nítida; senão, a foto horizontal de maior resolução da galeria
// (desenhos técnicos, de fundo quase todo branco, ficam de fora).
const HORIZONTAL = 1.3, NITIDA = 1800;
async function medida(r) {
  try {
    const img = sharp(path.join(SAIDA, r));
    const m = await img.metadata(), gira = (m.orientation || 1) >= 5;
    const w = gira ? m.height : m.width, h = gira ? m.width : m.height;
    const { channels } = await img.stats();
    const claro = channels.slice(0, 3).reduce((s, c) => s + c.mean, 0) / 3 > 215;
    return { w, h, horizontal: w / h >= HORIZONTAL, util: Math.min(w, h * 16 / 8.5), desenho: claro };
  } catch { return null; }
}
for (const p of projetos) {
  if (p.topo) continue;                                  // escolhida no painel
  const capa = p.capa && await medida(p.capa);
  if (capa && capa.horizontal && !capa.desenho && capa.util >= NITIDA) { p.topo = p.capa; continue; }
  let melhor = p.capa, nota = capa && !capa.desenho ? capa.util * (capa.w >= capa.h ? 1 : 0.6) : 0;
  for (const f of p.fotos) {
    const d = await medida(f);
    if (!d || !d.horizontal || d.desenho) continue;
    if (d.util > nota + 50) { melhor = f; nota = d.util; }
  }
  p.topo = melhor;
}

// JSON publicado ganha o campo "topo" calculado (o original no repositório não muda)
{
  const original = await lerJson("content/projetos.json");
  const topoPorNome = new Map(projetos.map(p => [p.nome, p.topo]));
  original.projetos = (original.projetos || []).map(x => x && x.nome && topoPorNome.get(x.nome) ? { ...x, topo: "/" + topoPorNome.get(x.nome) } : x);
  await fs.writeFile(path.join(SAIDA, "content", "projetos.json"), JSON.stringify(original, null, 2));
}

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
  p.og = (await gera(p.topo || p.capa, `imagens/_og/${p.slug}.jpg`, OG)) ? `imagens/_og/${p.slug}.jpg` : null;
}
const aberturaOg = (await gera("imagens/site/abertura.jpg", "imagens/_og/site.jpg", OG)) ? "imagens/_og/site.jpg" : null;

// ---------- 3b. Versão WebP de cada foto (30–50% mais leve; o site usa e cai no JPG/PNG se faltar) ----------
// Ex.: imagens/casa/01.jpg → imagens/casa/01.jpg.webp. As imagens de prévia (_og) ficam só em JPG (WhatsApp).
let webps = 0;
async function* fotosPublicadas(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "_og") yield* fotosPublicadas(p); }
    else if (/\.(jpe?g|png)$/i.test(e.name)) yield p;
  }
}
for await (const f of fotosPublicadas(path.join(SAIDA, "imagens"))) {
  await sharp(f).rotate().webp({ quality: 80, effort: 4 }).toFile(f + ".webp");
  webps++;
}

// ---------- 4. Páginas ----------
const modelo = await fs.readFile(path.join(RAIZ, "index.html"), "utf8");
const DESCRICAO = "Goya Arquitetura: projeto, construção e consultoria em taipa de pilão e arquitetura com terra.";

const jsonLd = obj => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
const escritorioLd = {
  "@type": "ProfessionalService",
  "@id": SITE_URL + "#escritorio",
  name: ESCRITORIO.nome,
  url: SITE_URL,
  image: SITE_URL + "imagens/_og/site.jpg",
  logo: SITE_URL + "imagens/site/apple-touch-icon-goya-v2.png",
  telephone: ESCRITORIO.telefone,
  email: ESCRITORIO.email,
  description: "Projeto, construção e consultoria em taipa de pilão e arquitetura com terra.",
  address: { "@type": "PostalAddress", streetAddress: ESCRITORIO.endereco.rua + ", " + ESCRITORIO.endereco.bairro,
    addressLocality: ESCRITORIO.endereco.cidade, addressRegion: ESCRITORIO.endereco.estado, addressCountry: ESCRITORIO.endereco.pais },
  sameAs: [ESCRITORIO.instagram],
  founder: { "@type": "Person", name: ESCRITORIO.fundador },
  areaServed: "BR",
  knowsAbout: ["Taipa de pilão", "Arquitetura com terra", "Construção com terra", "Consultoria em taipa de pilão"],
};
function seo({ titulo, descricao, url, imagem, dados }) {
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
    NOINDEX && `<meta name="robots" content="noindex, nofollow">`,
    !NOINDEX && INTEG.google_verificacao && `<meta name="google-site-verification" content="${esc(INTEG.google_verificacao)}">`,
    // Umami (visitas e metas, sem cookies) — só no site oficial
    !NOINDEX && INTEG.umami_id && `<script defer src="https://cloud.umami.is/script.js" data-website-id="${esc(INTEG.umami_id)}" data-domains="www.goyarq.com.br"></script>`,
    // Clarity: o código só é carregado pelo site se a pessoa aceitar os cookies (aviso no rodapé)
    !NOINDEX && INTEG.clarity_id && `<script>window.GOYA_CLARITY=${JSON.stringify(String(INTEG.clarity_id))}</script>`,
    dados && jsonLd({ "@context": "https://schema.org", "@graph": dados }),
  ].filter(Boolean).join("\n");
}
const montaPagina = (cabecalho, extra = h => h) =>
  extra(modelo
    .replace("<!--BASE-->", `<base href="${BASE}">`)
    .replace(/<!--SEO:inicio-->[\s\S]*?<!--SEO:fim-->/, cabecalho));

// Página inicial
await fs.writeFile(path.join(SAIDA, "index.html"),
  montaPagina(seo({ titulo: "Goya Arquitetura — arquitetura em terra e taipa de pilão", descricao: DESCRICAO, url: SITE_URL, imagem: aberturaOg,
    dados: [escritorioLd, { "@type": "WebSite", "@id": SITE_URL + "#site", url: SITE_URL, name: ESCRITORIO.nome, inLanguage: "pt-BR", publisher: { "@id": SITE_URL + "#escritorio" } }] })));

// Uma página por projeto. O conteúdo já vem escrito no HTML (Google lê mesmo sem rodar o JavaScript);
// no navegador, o JavaScript monta a mesma página com as animações e a galeria.
for (const p of projetos) {
  const url = `${SITE_URL}projetos/${p.slug}/`;
  const descricao = p.resumo || p.destaque || DESCRICAO;
  const paragrafos = String(p.memoria || "").split(/\n\s*\n/).map(t => t.trim()).filter(Boolean);
  const estatico = `<section id="projeto">
    <div class="d-head"><a href="#projetos" class="back">← Projetos</a><h1 class="title">${esc(p.nome)}</h1></div>
    ${p.topo ? `<div class="d-hero"><img src="${esc(p.topo)}" alt="${esc(p.nome)}"></div>` : ""}
    <div class="d-info${p.destaque || paragrafos.length ? "" : " so-ficha"}">${p.destaque || paragrafos.length ? `<div class="d-mem"><span class="eyebrow">Memória do projeto</span>
      ${p.destaque ? `<p class="d-lead">${esc(p.destaque)}</p>` : ""}
      ${paragrafos.map(t => `<p>${esc(t)}</p>`).join("\n      ")}</div>` : ""}
      <div class="d-ficha"><span class="eyebrow">Ficha técnica</span><dl>
        ${(p.ficha || []).filter(f => f && f.rotulo).map(f => `<div><dt>${esc(f.rotulo)}</dt><dd>${esc(f.valor)}</dd></div>`).join("")}
      </dl></div></div>
  </section>`;
  const html = montaPagina(
    seo({ titulo: `${p.nome} | Goya Arquitetura`, descricao, url, imagem: p.og, dados: [
      {
        "@type": "CreativeWork",
        "@id": url + "#projeto",
        name: p.nome,
        url,
        description: descricao,
        image: [p.topo, p.capa].filter(Boolean).map(f => SITE_URL + f),
        ...(p.ano ? { dateCreated: String(p.ano).split(/[–-]/)[0].trim() } : {}),
        ...(p.local ? { locationCreated: { "@type": "Place", name: p.local } } : {}),
        genre: p.categoria,
        creator: { "@id": SITE_URL + "#escritorio" },
        ...(p.selo && p.premio ? { award: "Architecture Hunter Awards — " + p.premio } : {}),
      },
      escritorioLd,
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Início", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Projetos", item: SITE_URL + "#projetos" },
        { "@type": "ListItem", position: 3, name: p.nome, item: url },
      ] },
    ] }),
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
await fs.writeFile(path.join(SAIDA, "robots.txt"), NOINDEX
  ? `User-agent: *\nDisallow: /\n`
  : `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`);

console.log(`✓ ${projetos.length} páginas de projeto · ${cards} miniaturas · ${webps} WebP · ${reduzidas} fotos reduzidas · ${copiadas} arquivos copiados`);
console.log(`  integrações: Search Console ${INTEG.google_verificacao ? "✓" : "—"} · Umami ${INTEG.umami_id ? "✓" : "—"} · Clarity ${INTEG.clarity_id ? "✓" : "—"}`);
console.log(`  endereço: ${SITE_URL}${NOINDEX ? "  (escondido do Google)" : ""}`);
