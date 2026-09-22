import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GITHUB_API_BASE = 'https://api.github.com';

// Os repositórios dos sites de cliente vivem nessa organização do GitHub
// ("DevZipMateus" foi renomeada pra "Montesite" em 2026-09-18; os repositórios
// que estavam em ZiplineTecnologia foram movidos pra cá também).
const GITHUB_OWNERS = ['Montesite'];

// Quantos sites reclassificar por execução, dos que estão há mais tempo sem
// checar (github_checked_at nulls first) - o cron seguinte continua de onde
// parou. Era 1000 (cobria a base toda numa rodada só) enquanto só checávamos
// o domínio ao vivo dos ~210 sites com repositório casado. Desde que passamos
// a checar TODO site ativo (~600, incluindo os ~420 sem repositório), o
// volume de trabalho por invocação triplicou e a função passou a estourar
// WORKER_RESOURCE_LIMIT (limite de CPU/recursos do worker) perto do fim de
// uma rodada, mesmo já reduzindo concorrência e limitando o tamanho da
// resposta lida (MAX_LIVE_BODY_BYTES). Baixado pra 300 pra cada invocação
// terminar com folga - o cron roda 2x/dia (ver github-sync-cron.yml) pra
// cobrir a base inteira em ~1 dia.
const BATCH_SIZE = 300;
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 8000;
const MAX_LIVE_BODY_BYTES = 1_500_000;

interface GithubRepo {
  name: string;
  owner: string;
  default_branch: string;
  pushed_at: string;
}

interface HostingWebsiteRow {
  id: string;
  domain: string;
  is_placeholder: boolean;
  is_decommissioned: boolean;
  github_backup_url: string | null;
  github_repo_owner: string | null;
  github_repo_name: string | null;
  linked_project_id: string | null;
  projects: { client_name: string } | { client_name: string }[] | null;
}

function slugifyName(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Domínio real quase sempre carrega o nome do negócio só no primeiro rótulo
// ("afpsolucoesindustriais.com.br" -> "afpsolucoesindustriais") - evita
// precisar de uma lista exaustiva de TLDs compostos (.com.br, .net.br etc.).
function domainSlug(domain: string): string {
  const host = domain.toLowerCase().replace(/^www\./, '').split('/')[0];
  const firstLabel = host.split('.')[0] ?? host;
  return slugifyName(firstLabel);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function githubFetch(path: string, token: string) {
  const res = await fetchWithTimeout(
    `${GITHUB_API_BASE}${path}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    FETCH_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`GitHub API ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function listAllRepos(owner: string, token: string): Promise<GithubRepo[]> {
  const repos: GithubRepo[] = [];
  let page = 1;
  while (true) {
    const data = await githubFetch(`/orgs/${owner}/repos?per_page=100&page=${page}&type=all`, token);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const r of data) {
      repos.push({ name: r.name, owner, default_branch: r.default_branch, pushed_at: r.pushed_at });
    }
    if (data.length < 100) break;
    page += 1;
  }
  return repos;
}

// O Cloudflare troca e-mails visíveis por um placeholder ofuscado
// (<span class="__cf_email__" data-cfemail="HEX">[email protected]</span>)
// que só vira o e-mail de verdade via JS. Sem decodificar isso, um site sem
// nenhuma mudança real aparece como "desatualizado" só por causa da proteção
// anti-spam. O primeiro byte hex é a chave XOR do resto.
function decodeCloudflareEmails(html: string): string {
  return html.replace(
    /<[a-z]+[^>]*class="__cf_email__"[^>]*data-cfemail="([0-9a-f]+)"[^>]*>.*?<\/[a-z]+>/gis,
    (_match, hex: string) => {
      try {
        const bytes = hex.match(/../g)?.map((h: string) => parseInt(h, 16)) ?? [];
        const key = bytes[0];
        return bytes.slice(1).map((b) => String.fromCharCode(b ^ key)).join('');
      } catch {
        return '';
      }
    }
  );
}

// Comparar o HTML bruto gera falso "desatualizado" toda hora: comentário
// adicionado, atributo reordenado, aspas trocadas, CSS/JS minificado
// diferente - nada disso é conteúdo de verdade. Extrai só o texto visível
// (sem título/script/style/comentários/tags) pra comparar o que realmente
// importa: se o que a pessoa vê na página mudou ou não.
function extractVisibleText(html: string): string {
  return decodeCloudflareEmails(html)
    .replace(/<title[\s\S]*?<\/title>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Site que roda inteiro em JS (React/Vue sem SSR) só entrega <div id="root">
// vazio pro fetch() - sem executar o JS não tem como saber se bate ou não
// com o backup. Sem essa checagem, todo site assim vira falso "desatualizado"
// (o texto extraído fica quase vazio, só o pouco que não depende de JS).
const MIN_RENDERED_TEXT_LENGTH = 50;

// Quando o DNS do domínio ainda aponta pra outra hospedagem (ex: HostGator,
// mesmo com o site provisionado certinho na Hostinger/VPS), quem responde é a
// página padrão/estacionada do outro provedor, não o site publicado. Isso não
// é um bug de sincronismo com o GitHub - é o domínio que precisa ser
// realinhado pelo dono/cliente, então vira uma flag separada
// (needs_client_action) em vez de um falso "outdated". Achado auditando
// mgservicefood.com.br manualmente (2026-09-18): nameservers ainda em
// ns786/787.hostgator.com.br.
const HOSTING_PLACEHOLDER_SIGNATURES: { note: string; pattern: RegExp }[] = [
  { note: 'Domínio aponta para a página temporária da HostGator ("Bem-vindo a HostGator" / "publicar seu site") - DNS desatualizado, ainda não migrado pra nossa hospedagem', pattern: /bem-vindo a hostgator|latam-files\.hostgator\.com\/system\/temporary-page/i },
  { note: 'Domínio aponta para a página padrão da HostGator/cPanel ("Future home of something quite cool") - DNS provavelmente desatualizado', pattern: /future home of something quite cool/i },
  { note: 'Domínio aponta para a página padrão de servidor (cPanel/Apache) - DNS provavelmente desatualizado', pattern: /this is the default (index\.html )?page for this server/i },
  { note: 'Domínio aponta para a página padrão do Apache ("Apache2 Ubuntu Default Page") - DNS provavelmente desatualizado', pattern: /apache2 ubuntu default page/i },
  { note: 'Domínio aponta para a página padrão do Nginx ("Welcome to nginx!") - DNS provavelmente desatualizado', pattern: /welcome to nginx!/i },
  { note: 'Domínio sem site publicado - servidor devolveu listagem de diretório ("Index of /")', pattern: /<title>\s*index of \//i },
  { note: 'Domínio estacionado (parked) em registrador - sem site publicado', pattern: /this domain is parked|domain has expired|buy this domain/i },
];

function detectHostingPlaceholder(html: string): string | null {
  for (const { note, pattern } of HOSTING_PLACEHOLDER_SIGNATURES) {
    if (pattern.test(html)) return note;
  }
  return null;
}

// Domínios do nosso próprio ambiente na Hostinger ("Faça Seu Site" e os
// subdomínios de prévia), não hospedagem de cliente. Ficam no ar de propósito
// e respondem 403/certificado próprio por design, então checar se "estão no
// ar" só gera alarme falso numa aba que existe pra listar site de cliente com
// problema. Confirmado com o usuário em 2026-09-22: mantê-los na Hostinger.
const INTERNAL_DOMAIN_SUFFIXES = ['facaseusite.com.br'];

function isInternalDomain(domain: string): boolean {
  const host = domain.toLowerCase().replace(/^www\./, '').split('/')[0];
  return INTERNAL_DOMAIN_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

interface LiveCheckResult {
  html: string | null;
  needsClientAction: boolean;
  note: string | null;
}

// Lê no máximo MAX_LIVE_BODY_BYTES do corpo da resposta - o suficiente pra
// qualquer checagem de texto/placeholder que fazemos, sem carregar na memória
// uma resposta anormalmente grande (vídeo/arquivo servido sem content-type
// correto, página com payload gigante etc.) que um domínio de terceiro pode
// devolver sem aviso nenhum.
async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= maxBytes) {
          await reader.cancel();
          break;
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(buf);
}

// Checa se o domínio está de pé, independente de ter repositório do GitHub
// associado ou não - antes, sites sem repositório encontrado (~2/3 da base)
// nunca tinham o próprio domínio checado, então um domínio derrubado ou com
// DNS quebrado nesse grupo passava batido. Agora todo site ativo (exceto os
// já marcados como sem hospedagem) tem o domínio realmente aberto e checado.
async function checkLiveSite(domain: string): Promise<LiveCheckResult> {
  try {
    const res = await fetchWithTimeout(`https://${domain}/`, { redirect: 'follow' }, FETCH_TIMEOUT_MS);
    if (!res.ok) {
      return {
        html: null,
        needsClientAction: true,
        note: `Site respondeu HTTP ${res.status} ao vivo - hospedagem ou domínio com problema`,
      };
    }
    const html = await readTextCapped(res, MAX_LIVE_BODY_BYTES);
    const placeholderNote = detectHostingPlaceholder(html);
    return { html, needsClientAction: !!placeholderNote, note: placeholderNote };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      html: null,
      needsClientAction: true,
      note: `Site não respondeu (${message}) - domínio pode estar com DNS quebrado, certificado inválido ou fora do ar`,
    };
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get('Authorization') ?? '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '');
    const cronSecret = Deno.env.get('CRON_SYNC_SECRET');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const authorized = (!!cronSecret && bearer === cronSecret) || (!!anonKey && bearer === anonKey);
    if (!authorized) {
      return new Response(JSON.stringify({ success: false, error: 'Não autorizado' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const githubToken = Deno.env.get('GITHUB_API_TOKEN');
    if (!githubToken) {
      return new Response(
        JSON.stringify({ success: false, error: 'GITHUB_API_TOKEN não configurado' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 1. Lista todos os repositórios da organização uma vez só.
    const allRepos = (
      await Promise.all(GITHUB_OWNERS.map((owner) => listAllRepos(owner, githubToken)))
    ).flat();

    const repoBySlug = new Map<string, GithubRepo[]>();
    for (const repo of allRepos) {
      const slug = slugifyName(repo.name);
      const list = repoBySlug.get(slug) ?? [];
      list.push(repo);
      repoBySlug.set(slug, list);
    }
    function bestRepoMatch(slug: string): GithubRepo | null {
      const candidates = repoBySlug.get(slug);
      if (!candidates || candidates.length === 0) return null;
      return candidates.slice().sort((a, b) => (a.pushed_at < b.pushed_at ? 1 : -1))[0];
    }

    // 2. Pega o lote de sites mais desatualizados (nunca checados primeiro).
    const { data: sites, error: sitesError } = await supabase
      .from('hosting_websites')
      .select('id, domain, is_placeholder, is_decommissioned, github_backup_url, github_repo_owner, github_repo_name, linked_project_id, projects:linked_project_id (client_name)')
      .eq('is_placeholder', false)
      .order('github_checked_at', { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE);
    if (sitesError) throw sitesError;

    const now = new Date().toISOString();
    let matched = 0;
    let synced = 0;
    let outdated = 0;
    let noMatch = 0;
    let errors = 0;
    let needsClientAction = 0;
    let internal = 0;

    await mapWithConcurrency(sites ?? [], CONCURRENCY, async (site: HostingWebsiteRow) => {
      // Domínio interno nosso: só registra que passou pela rodada, sem abrir o
      // site nem procurar repositório, e limpa qualquer flag de problema que
      // tenha sobrado de antes de existir essa exceção.
      if (isInternalDomain(site.domain)) {
        internal += 1;
        await supabase
          .from('hosting_websites')
          .update({
            github_sync_status: 'internal',
            github_checked_at: now,
            needs_client_action: false,
            client_action_note: null,
          })
          .eq('id', site.id);
        return;
      }

      const clientName = Array.isArray(site.projects) ? site.projects[0]?.client_name : site.projects?.client_name;

      let repo: GithubRepo | null = null;
      if (site.github_repo_owner && site.github_repo_name) {
        repo = allRepos.find((r) => r.owner === site.github_repo_owner && r.name === site.github_repo_name) ?? null;
      }
      if (!repo) {
        repo = bestRepoMatch(domainSlug(site.domain)) ?? (clientName ? bestRepoMatch(slugifyName(clientName)) : null);
      }

      if (!repo) {
        noMatch += 1;
        const update: Record<string, unknown> = { github_sync_status: 'no_match', github_checked_at: now };
        if (!site.is_decommissioned) {
          const live = await checkLiveSite(site.domain);
          update.needs_client_action = live.needsClientAction;
          update.client_action_note = live.note;
          if (live.needsClientAction) needsClientAction += 1;
        }
        await supabase.from('hosting_websites').update(update).eq('id', site.id);
        return;
      }

      matched += 1;
      const update: Record<string, unknown> = {
        github_repo_owner: repo.owner,
        github_repo_name: repo.name,
        github_checked_at: now,
      };
      if (!site.github_backup_url) {
        update.github_backup_url = `https://github.com/${repo.owner}/${repo.name}`;
      }

      try {
        const commit = await githubFetch(`/repos/${repo.owner}/${repo.name}/commits/${repo.default_branch}`, githubToken);
        update.github_commit_sha = commit.sha;
        update.github_commit_at = commit.commit?.author?.date ?? null;

        if (site.is_decommissioned) {
          update.github_sync_status = 'no_live_site';
        } else {
          const contentRes = await githubFetch(
            `/repos/${repo.owner}/${repo.name}/contents/index.html?ref=${commit.sha}`,
            githubToken
          );
          // atob() sozinho devolve uma "binary string" (1 char = 1 byte) - se
          // decodificada direto ela trata cada byte UTF-8 como um caractere
          // Latin1, corrompendo qualquer acento e fazendo o hash nunca bater
          // com o HTML ao vivo (que o fetch já decodifica como UTF-8 de verdade).
          const repoBytes = Uint8Array.from(atob((contentRes.content ?? '').replace(/\s/g, '')), (c) => c.charCodeAt(0));
          const repoHtml = new TextDecoder('utf-8').decode(repoBytes);

          // Checa o domínio ao vivo separado do restante (que é tudo API do
          // GitHub) - assim uma falha de rede no domínio do cliente não vira
          // um "fetch_error" genérico misturado com falha da API do GitHub,
          // e sim um needs_client_action com o motivo de verdade.
          const live = await checkLiveSite(site.domain);
          update.needs_client_action = live.needsClientAction;
          update.client_action_note = live.note;
          if (live.needsClientAction) {
            needsClientAction += 1;
          }

          if (live.html === null) {
            update.github_sync_status = 'site_unreachable';
          } else if (/\/src\/main\.tsx/.test(repoHtml)) {
            // Alguns repositórios guardam o projeto-fonte (Vite/React) em vez
            // do HTML já publicado - o index.html deles aponta pro entry
            // point de dev ("/src/main.tsx") e nunca vai bater com o site ao
            // vivo (que é a versão compilada). Comparar os dois é sempre
            // falso "outdated", então nem tenta - só registra que é fonte.
            update.github_sync_status = 'source_only';
          } else {
            const liveText = extractVisibleText(live.html);

            if (liveText.length < MIN_RENDERED_TEXT_LENGTH) {
              update.github_sync_status = 'render_required';
            } else {
              const [repoHash, liveHash] = await Promise.all([
                sha256Hex(extractVisibleText(repoHtml)),
                sha256Hex(liveText),
              ]);

              if (repoHash === liveHash) {
                update.github_sync_status = 'synced';
                synced += 1;
              } else {
                update.github_sync_status = 'outdated';
                outdated += 1;
              }
            }
          }
        }
      } catch (e) {
        errors += 1;
        update.github_sync_status = 'fetch_error';
        console.error(`Falha ao comparar ${site.domain} com ${repo.owner}/${repo.name} (API do GitHub):`, e);
      }

      await supabase.from('hosting_websites').update(update).eq('id', site.id);
    });

    return new Response(
      JSON.stringify({
        success: true,
        synced_at: now,
        total_repos: allRepos.length,
        sites_checked: sites?.length ?? 0,
        matched,
        synced,
        outdated,
        no_match: noMatch,
        errors,
        needs_client_action: needsClientAction,
        internal,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('💥 Erro em github-sync:', error);
    const message = error instanceof Error ? error.message : 'Erro interno';
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
