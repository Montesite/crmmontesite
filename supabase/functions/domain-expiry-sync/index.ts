import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Só existe pra alimentar a aba "Vencendo em breve" com data de expiração real
// de domínio - o github-sync só consulta o RDAP quando o site já está
// needs_client_action (ou seja, já caiu). Pra avisar ANTES de cair, precisa
// checar todo domínio .br ativo, não só os já quebrados. Roda 1x/semana (ver
// domain-expiry-sync-cron.yml) e reconsulta o lote mais antigo primeiro
// (domain_checked_at nulls first) - com BATCH_SIZE=150 e ~600 domínios .br na
// base, cada domínio é reconferido a cada ~4 semanas, o suficiente já que data
// de expiração não muda de uma hora pra outra.
const BATCH_SIZE = 150;
const CONCURRENCY = 2;
const FETCH_TIMEOUT_MS = 8000;
// registro.br passou a devolver falha de rede em ~60% das consultas quando
// batemos nele com CONCURRENCY=5 sem pausa (achado rodando essa função pela
// primeira vez, 2026-09-22: 120 de 200 deram check_failed). É rate limit do
// lado deles, não timeout nosso. Com 2 workers em paralelo + essa pausa entre
// cada request, fica numa cadência bem mais conservadora (~4 req/s no pico).
const THROTTLE_MS = 400;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface HostingWebsiteRow {
  id: string;
  domain: string;
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

// Mesma lista de sufixos de segundo nível do github-sync - ver comentário lá
// pra detalhes de por que precisa disso pra achar o apex certo do domínio.
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
  status: string;
  expiresAt: string | null;
  nameservers: string | null;
}

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

    // Só domínios .br (RDAP público que temos hoje), ativos (nem sem
    // hospedagem nem placeholder interno) - o lote mais antigo primeiro.
    const { data: sites, error: sitesError } = await supabase
      .from('hosting_websites')
      .select('id, domain')
      .eq('is_placeholder', false)
      .eq('is_decommissioned', false)
      .ilike('domain', '%.br')
      .order('domain_checked_at', { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE);
    if (sitesError) throw sitesError;

    const now = new Date().toISOString();
    let checked = 0;
    let expiringSoon = 0;
    let notRegistered = 0;
    let failed = 0;

    const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

    await mapWithConcurrency(sites ?? [], CONCURRENCY, async (site: HostingWebsiteRow) => {
      await sleep(THROTTLE_MS);
      const registry = await checkDomainRegistryBr(site.domain);
      if (!registry) return;
      checked += 1;
      if (registry.status === 'check_failed') {
        failed += 1;
        return; // não sobrescreve dado bom anterior com uma falha de rede pontual
      }
      if (registry.status === 'not_registered') notRegistered += 1;
      if (
        registry.expiresAt &&
        new Date(registry.expiresAt).getTime() - Date.now() < SIXTY_DAYS_MS &&
        new Date(registry.expiresAt).getTime() > Date.now()
      ) {
        expiringSoon += 1;
      }
      await supabase
        .from('hosting_websites')
        .update({
          domain_registry_status: registry.status,
          domain_expires_at: registry.expiresAt,
          domain_nameservers: registry.nameservers,
          domain_checked_at: now,
        })
        .eq('id', site.id);
    });

    return new Response(
      JSON.stringify({
        success: true,
        synced_at: now,
        sites_checked: sites?.length ?? 0,
        checked,
        expiring_soon_60d: expiringSoon,
        not_registered: notRegistered,
        failed,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('💥 Erro em domain-expiry-sync:', error);
    const message = error instanceof Error ? error.message : 'Erro interno';
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
