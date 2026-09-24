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

// Sufixos de segundo nível reais do .br (registro.br) - sem essa lista não dá
// pra saber se "previa.cliente.com.br" tem apex "cliente.com.br" (3 rótulos)
// ou se um domínio como "empresa.br" (registro direto, 2 rótulos) já é o
// apex. Precisamos do apex certo pra consultar o RDAP (ele só responde pelo
// domínio registrável, não por qualquer subdomínio).
const BR_SECOND_LEVEL_SUFFIXES = new Set([
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'mil.br', 'art.br', 'adv.br', 'arq.br', 'bio.br',
  'bmd.br', 'cim.br', 'cng.br', 'cnt.br', 'coop.br', 'ecn.br', 'eco.br', 'emp.br', 'eng.br', 'esp.br',
  'etc.br', 'eti.br', 'far.br', 'fnd.br', 'fot.br', 'fst.br', 'g12.br', 'ggf.br', 'imb.br', 'ind.br',
  'inf.br', 'jor.br', 'jus.br', 'leg.br', 'lel.br', 'mat.br', 'med.br', 'mus.br', 'not.br', 'ntr.br',
  'odo.br', 'ppg.br', 'pro.br', 'psc.br', 'psi.br', 'qsl.br', 'radio.br', 'rec.br', 'slg.br', 'srv.br',
  'tmp.br', 'trd.br', 'tur.br', 'tv.br', 'vet.br', 'vlog.br', 'wiki.br', 'zlg.br',
]);

function getBrApexDomain(domain: string): string | null {
  const host = domain.toLowerCase().replace(/^www\./, '').split('/')[0].split(':')[0];
  if (!host.endsWith('.br')) return null;
  const labels = host.split('.');
  if (labels.length >= 3 && BR_SECOND_LEVEL_SUFFIXES.has(labels.slice(-2).join('.'))) {
    return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

interface DomainRegistryInfo {
  status: string; // 'active' | 'inactive' | 'not_registered' | 'check_failed' | outro status cru do RDAP
  expiresAt: string | null;
  nameservers: string | null;
}

// Achado auditando manualmente os sites "fora do ar" em 2026-09-22 (planilha
// do Victor): a mensagem genérica de erro de rede não distingue "domínio
// vencido", "domínio nem chegou a ser registrado de verdade" (caso real:
// ferrovelholeonardo.com.br aparecia "Active" na API da Hostinger mas o RDAP
// do registro.br devolvia 404 - disponível pra qualquer um registrar) e
// "domínio ativo, problema é só de DNS/hospedagem". O RDAP público do
// registro.br (sem chave, sem custo) resolve isso pra qualquer TLD .br -
// ainda não cobrimos outros TLDs (precisariam de outro serviço RDAP por
// registro).
async function checkDomainRegistryBr(domain: string): Promise<DomainRegistryInfo | null> {
  const apex = getBrApexDomain(domain);
  if (!apex) return null;
  try {
    const res = await fetchWithTimeout(`https://rdap.registro.br/domain/${apex}`, {}, FETCH_TIMEOUT_MS);
    if (res.status === 404) {
      return { status: 'not_registered', expiresAt: null, nameservers: null };
    }
    if (!res.ok) {
      return { status: 'check_failed', expiresAt: null, nameservers: null };
    }
    const data = await res.json();
    const statusList: string[] = Array.isArray(data.status) ? data.status : [];
    const status = statusList.includes('active') ? 'active' : statusList.includes('inactive') ? 'inactive' : (statusList[0] ?? 'unknown');
    const events = Array.isArray(data.events) ? data.events : [];
    const expiresAt = events.find((e: { eventAction?: string }) => e.eventAction === 'expiration')?.eventDate ?? null;
    const nsList = Array.isArray(data.nameservers) ? data.nameservers : [];
    const nameservers = nsList.map((ns: { ldhName?: string }) => ns.ldhName).filter(Boolean).join(', ') || null;
    return { status, expiresAt, nameservers };
  } catch (e) {
    console.error(`Falha ao consultar RDAP registro.br pra ${apex}:`, e);
    return { status: 'check_failed', expiresAt: null, nameservers: null };
  }
}

function formatDateBr(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
  } catch {
    return iso;
  }
}

// Monta uma mensagem específica a partir do status real do registro,
// substituindo a mensagem genérica de "DNS quebrado, certificado inválido ou
// fora do ar" por um diagnóstico acionável.
function buildRegistryNote(registry: DomainRegistryInfo, fallbackNote: string | null): string {
  if (registry.status === 'not_registered') {
    return '🚨 Domínio NÃO está registrado no registro.br (disponível pra qualquer um registrar agora) - risco de perda, registrar imediatamente se for manter.';
  }
  if (registry.status === 'inactive') {
    const expired = !!registry.expiresAt && new Date(registry.expiresAt).getTime() < Date.now();
    if (expired) {
      return `Domínio vencido em ${formatDateBr(registry.expiresAt!)} (registro.br) - renovar para voltar ao ar.`;
    }
    const expiresText = registry.expiresAt ? formatDateBr(registry.expiresAt) : 'data desconhecida';
    return `Domínio com pendência no registro.br (dados do titular ou documentação, não é falta de pagamento) - ainda dentro da validade (vence ${expiresText}). Verificar pendência no painel do registro.br.`;
  }
  if (registry.status === 'active') {
    const suffix = registry.expiresAt ? ` (vence ${formatDateBr(registry.expiresAt)})` : '';
    return `${fallbackNote ?? 'Site fora do ar'} - domínio está ativo/registrado${suffix}; problema é de DNS ou hospedagem, não do registro do domínio.`;
  }
  return fallbackNote ?? 'Site fora do ar - motivo não identificado.';
}

interface RegistryUpdateFields {
  client_action_note: string | null;
  domain_registry_status: string | null;
  domain_expires_at: string | null;
  domain_nameservers: string | null;
  domain_checked_at: string | null;
}

// Só consulta o RDAP quando o domínio já foi flagado com problema - a imensa
// maioria dos ~600 sites ativos está saudável, então chamar o registro.br pra
// todo mundo seria trabalho e risco de rate-limit à toa.
async function buildRegistryFields(domain: string, live: LiveCheckResult, now: string): Promise<RegistryUpdateFields> {
  if (!live.needsClientAction) {
    return {
      client_action_note: live.note,
      domain_registry_status: null,
      domain_expires_at: null,
      domain_nameservers: null,
      domain_checked_at: null,
    };
  }
  const registry = await checkDomainRegistryBr(domain);
  if (!registry) {
    return {
      client_action_note: live.note,
      domain_registry_status: null,
      domain_expires_at: null,
      domain_nameservers: null,
      domain_checked_at: null,
    };
  }
  return {
    client_action_note: buildRegistryNote(registry, live.note),
    domain_registry_status: registry.status,
    domain_expires_at: registry.expiresAt,
    domain_nameservers: registry.nameservers,
    domain_checked_at: now,
  };
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

type FetchAttempt = { ok: true; html: string } | { ok: false; status: number | null; message: string };

async function fetchLivePage(url: string): Promise<FetchAttempt> {
  try {
    const res = await fetchWithTimeout(url, { redirect: 'follow' }, FETCH_TIMEOUT_MS);
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, status: res.status, message: `HTTP ${res.status}` };
    }
    return { ok: true, html: await readTextCapped(res, MAX_LIVE_BODY_BYTES) };
  } catch (e) {
    return { ok: false, status: null, message: e instanceof Error ? e.message : String(e) };
  }
}

// Uma tentativa só gerava falso "fora do ar" com qualquer falha passageira
// (erro de HTTP/2 via IPv6, timeout pontual) - dipaulacontabilidade.com.br e
// dearf.com.br caíram na lista assim em 2026-09-23/24 estando no ar. Tenta de
// novo antes de concluir; 4xx (exceto 429) é resposta definitiva do servidor.
const RETRY_DELAY_MS = 2000;

async function fetchLivePageWithRetry(url: string): Promise<FetchAttempt> {
  const first = await fetchLivePage(url);
  if (first.ok) return first;
  if (first.status !== null && first.status < 500 && first.status !== 429) return first;
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  return await fetchLivePage(url);
}

// Checa se o domínio está de pé, independente de ter repositório do GitHub
// associado ou não - antes, sites sem repositório encontrado (~2/3 da base)
// nunca tinham o próprio domínio checado, então um domínio derrubado ou com
// DNS quebrado nesse grupo passava batido. Agora todo site ativo (exceto os
// já marcados como sem hospedagem) tem o domínio realmente aberto e checado.
async function checkLiveSite(domain: string): Promise<LiveCheckResult> {
  const apex = await fetchLivePageWithRetry(`https://${domain}/`);
  if (apex.ok) {
    const placeholderNote = detectHostingPlaceholder(apex.html);
    return { html: apex.html, needsClientAction: !!placeholderNote, note: placeholderNote };
  }

  // Achado em 2026-09-24: 8 sites migrados pra VPS ficaram com um "A @" antigo
  // (página estacionada da Hostinger, sem SSL) ao lado do ALIAS certo - o www
  // abria normal e o domínio sem www não. Continua precisando de ação, mas a
  // nota diz exatamente o que corrigir em vez do genérico "fora do ar".
  if (!domain.toLowerCase().startsWith('www.')) {
    const www = await fetchLivePageWithRetry(`https://www.${domain}/`);
    if (www.ok && !detectHostingPlaceholder(www.html)) {
      return {
        html: www.html,
        needsClientAction: true,
        note: `Só o www funciona - https://${domain}/ falhou (${apex.message}). Provável registro "A @" antigo na DNS apontando pra outro servidor`,
      };
    }
  }

  if (apex.status !== null) {
    return {
      html: null,
      needsClientAction: true,
      note: `Site respondeu HTTP ${apex.status} ao vivo - hospedagem ou domínio com problema`,
    };
  }
  return {
    html: null,
    needsClientAction: true,
    note: `Site não respondeu (${apex.message}) - domínio pode estar com DNS quebrado, certificado inválido ou fora do ar`,
  };
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
    // Com { only_flagged: true } (botão "Sincronizar agora" da aba Hospedagem)
    // recheca só quem está hoje na aba "Fora do ar" - o lote normal de 300
    // pode levar ~1 dia pra chegar num site que já foi corrigido.
    const body = await req.json().catch(() => ({}));
    const onlyFlagged = body?.only_flagged === true;
    let sitesQuery = supabase
      .from('hosting_websites')
      .select('id, domain, is_placeholder, is_decommissioned, github_backup_url, github_repo_owner, github_repo_name, linked_project_id, projects:linked_project_id (client_name)')
      .eq('is_placeholder', false);
    if (onlyFlagged) sitesQuery = sitesQuery.eq('needs_client_action', true);
    const { data: sites, error: sitesError } = await sitesQuery
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
          Object.assign(update, await buildRegistryFields(site.domain, live, now));
          if (live.needsClientAction) needsClientAction += 1;
        } else {
          // Site sem hospedagem é caso encerrado - sem isso a flag de antes da
          // exclusão ficava pra sempre na aba "Fora do ar".
          update.needs_client_action = false;
          update.client_action_note = null;
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

      // Checa o domínio ao vivo antes (e fora) das chamadas à API do GitHub -
      // assim uma falha de rede no domínio do cliente não vira um
      // "fetch_error" genérico, e uma falha da API do GitHub não deixa a flag
      // needs_client_action da rodada anterior congelada.
      let live: LiveCheckResult | null = null;
      if (site.is_decommissioned) {
        update.needs_client_action = false;
        update.client_action_note = null;
      } else {
        live = await checkLiveSite(site.domain);
        update.needs_client_action = live.needsClientAction;
        Object.assign(update, await buildRegistryFields(site.domain, live, now));
        if (live.needsClientAction) needsClientAction += 1;
      }

      try {
        const commit = await githubFetch(`/repos/${repo.owner}/${repo.name}/commits/${repo.default_branch}`, githubToken);
        update.github_commit_sha = commit.sha;
        update.github_commit_at = commit.commit?.author?.date ?? null;

        if (!live) {
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
