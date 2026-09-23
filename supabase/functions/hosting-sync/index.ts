import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const HOSTINGER_API_BASE = 'https://developers.hostinger.com/api';

// Limite de sites de cada plano, conhecido manualmente (hPanel / contrato).
// A API da Hostinger não expõe um endpoint de "quota de sites" por plano.
const KNOWN_SITE_LIMITS: Record<string, number> = {
  agency_growth: 300,
  cloud_professional: 300,
};

interface HostingerWebsite {
  domain: string;
  order_id: number;
  vhost_type?: string;
}

interface AgencyWebsite {
  order_id: number;
  details: { uid: string; domains: { fqdn: string; primary: boolean }[] };
}

function isPlaceholderDomain(domain: string) {
  return /\.hostingersite\.com$/i.test(domain);
}

// Domínio de projeto costuma vir como URL completa colada pelo usuário
// ("https://www.site.com.br/", "https://site.com.br/#home") - sem remover
// protocolo/caminho/fragmento ele nunca batia com o domínio "limpo" que a
// Hostinger retorna, deixando o vínculo automático (ver projectByDomain)
// silenciosamente sem efeito pra boa parte dos projetos.
function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/#?].*$/, '');
}

// Consulta a lista real de domínios hospedados na VPS Hestia, pra saber se um
// site que sumiu da Hostinger foi realmente migrado pra lá (deleted_at + ainda
// "vps") ou se foi removido por outro motivo (deleted_at + is_decommissioned
// = true). Sem isso não dava pra distinguir os dois casos - qualquer site que
// saísse da Hostinger virava "Migrado p/ VPS" (ou "cancelado") por padrão,
// dependendo do fallback, estivesse ele lá ou não.
//
// A VPS antiga (AdminBolt) foi desligada em 2026-09-22 e substituída por
// HestiaCP, que não tem API exposta pra internet (só 127.0.0.1:8083). Em vez
// disso, um script + cron na própria VPS (/usr/local/bin/dump-vps-domains.sh)
// publica a lista de domínios como JSON estático num caminho com token
// aleatório embutido no vhost padrão da VPS (srv1988116.hstgr.cloud), servido
// por HTTPS normal (Let's Encrypt) - não precisa de CA custom nem de headers
// de autenticação, só GET simples com timeout.
const VPS_DOMAINS_URL =
  'https://srv1988116.hstgr.cloud/vps-domains-8d6ffe81132ac7351c44648f3f3d3becaa85f789d12ab908.json';

async function fetchVpsDomains(): Promise<Set<string>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(VPS_DOMAINS_URL, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`VPS domains endpoint -> HTTP ${res.status}`);
    }
    const domains: string[] = await res.json();
    return new Set(domains.map((d) => d.toLowerCase()));
  } finally {
    clearTimeout(timer);
  }
}

async function hostingerFetch(path: string, token: string) {
  const res = await fetch(`${HOSTINGER_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Hostinger API ${path} -> HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

async function fetchAllPages<T>(
  basePath: string,
  token: string,
  extraQuery = ''
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    const sep = extraQuery ? '&' : '?';
    const data = await hostingerFetch(
      `${basePath}?page=${page}&per_page=${perPage}${extraQuery ? sep + extraQuery : ''}`,
      token
    );
    items.push(...(data.data ?? []));
    const meta = data.meta;
    if (!meta || items.length >= meta.total || (data.data ?? []).length === 0) break;
    page += 1;
  }
  return items;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Autorização: aceita o segredo do cron OU a chave anon do próprio projeto
    // (é o que o frontend do CRM envia — este app não usa sessões de usuário
    // reais do Supabase Auth, o login é só uma flag local no navegador).
    // O segredo do cron precisa ter o MESMO valor guardado no Supabase Vault
    // como 'cron_hosting_sync_secret', que é de onde o job do pg_cron lê para
    // montar o header Authorization (ver migration).
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

    const hostingerToken = Deno.env.get('HOSTINGER_API_TOKEN');
    if (!hostingerToken) {
      return new Response(
        JSON.stringify({ success: false, error: 'HOSTINGER_API_TOKEN não configurado' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 1. Descobrir as orders de cada plano
    const hostingOrders = await hostingerFetch('/hosting/v1/orders', hostingerToken);
    const agencyOrders = await hostingerFetch('/agency-hosting/v1/orders', hostingerToken);

    // Carrega todos os domínios de projetos do CRM UMA vez, para casar sites novos
    // em memória em vez de fazer uma consulta por site (era isso que estava
    // deixando a sincronização lenta o suficiente para estourar o tempo limite).
    const { data: allProjects } = await supabase.from('projects').select('id, domain').not('domain', 'is', null);
    const projectByDomain = new Map(
      (allProjects ?? [])
        .filter((p) => !!p.domain)
        .map((p) => [normalizeDomain(p.domain!), p.id])
    );

    let vpsDomains = new Set<string>();
    try {
      vpsDomains = await fetchVpsDomains();
    } catch (e) {
      console.error('Falha ao buscar domínios da VPS Hestia - sites removidos da Hostinger não serão reclassificados corretamente nesta execução:', e);
    }

    const createdEvents: { domain: string; order_id: number }[] = [];
    const deletedEvents: { domain: string; order_id: number }[] = [];
    const planSummaries: Record<string, unknown>[] = [];
    const eventsToInsert: Record<string, unknown>[] = [];

    const now = new Date().toISOString();

    // Aplica o diff de uma order inteira contra o banco com no máximo 3 chamadas
    // ao Postgres (select existentes, upsert em lote, update em lote de removidos).
    async function syncOrderWebsites(
      orderId: number,
      platform: 'cloudlinux' | 'h5g',
      websites: { domain: string; external_uid?: string }[]
    ) {
      const domainSet = new Set(websites.map((w) => w.domain.toLowerCase()));

      const { data: existing, error: existingError } = await supabase
        .from('hosting_websites')
        .select('domain, deleted_at, first_seen_at, linked_project_id')
        .eq('order_id', orderId);
      if (existingError) throw existingError;

      const existingMap = new Map((existing ?? []).map((r) => [r.domain.toLowerCase(), r]));

      // Cada linha do upsert precisa ter exatamente as MESMAS colunas, com um valor
      // explícito em todas elas. O PostgREST monta um único INSERT com a união das
      // chaves de todos os objetos do lote; se uma linha "pula" uma coluna que outra
      // linha do mesmo lote define, ele manda NULL nessa coluna em vez de aplicar o
      // default da tabela - e isso já quebrou o sync inteiro (violação de NOT NULL em
      // first_seen_at) sempre que um lote misturava sites novos com sites já conhecidos.
      const rowsToUpsert = websites.map((site) => {
        const domainLower = normalizeDomain(site.domain);
        const existingRow = existingMap.get(site.domain.toLowerCase());
        const isNew = !existingRow;
        if (isNew) {
          createdEvents.push({ domain: site.domain, order_id: orderId });
          eventsToInsert.push({
            event_type: 'site_created',
            domain: site.domain,
            order_id: orderId,
            detail: { platform },
          });
        }
        // Um projeto pode ganhar o domínio bem depois do site já estar sincronizado
        // (é o que acontece ao mover pra "pronto" e preencher o domínio agora) - por
        // isso sites já existentes também tentam casar por domínio, não só os novos.
        // Nunca sobrescreve um vínculo manual já definido (linked_project_id existente).
        const linkedProjectId = existingRow
          ? existingRow.linked_project_id ?? projectByDomain.get(domainLower) ?? null
          : projectByDomain.get(domainLower) ?? null;
        return {
          order_id: orderId,
          external_uid: site.external_uid ?? null,
          domain: site.domain,
          platform,
          is_placeholder: isPlaceholderDomain(site.domain),
          last_seen_at: now,
          deleted_at: null,
          linked_project_id: linkedProjectId,
          first_seen_at: existingRow ? existingRow.first_seen_at : now,
        };
      });

      if (rowsToUpsert.length > 0) {
        const { error: upsertError } = await supabase
          .from('hosting_websites')
          .upsert(rowsToUpsert, { onConflict: 'order_id,domain' });
        if (upsertError) throw upsertError;
      }

      const domainsGoneMissing = [...existingMap.entries()]
        .filter(([domainLower, row]) => !domainSet.has(domainLower) && !row.deleted_at)
        .map(([, row]) => row.domain);

      if (domainsGoneMissing.length > 0) {
        // Se por algum motivo o endpoint de domínios da VPS (ver
        // fetchVpsDomains) não responder nesta execução, vpsDomains fica
        // vazio e não dá pra saber se um domínio sumido foi migrado ou
        // cancelado - o fallback então assume "decommissioned" (cancelado),
        // nunca "migrado pra VPS" sem confirmação. Motivo: esse fallback já
        // tratou tudo como "migrado pra VPS" por padrão no passado e chegou a
        // classificar ~30 sites deletados manualmente da Hostinger em
        // 2026-09-22 (achado auditando o pedido do usuário sobre os domínios
        // lelepepe que ele excluiu) como "Migrado p/ VPS" quando na verdade
        // foram apenas cancelados. Prefere errar pra "cancelado" (que o
        // usuário revisa manualmente) a inventar uma migração que não houve.
        const vpsCheckAvailable = vpsDomains.size > 0;
        const migratedToVps = vpsCheckAvailable
          ? domainsGoneMissing.filter((d) => vpsDomains.has(d.toLowerCase()))
          : [];
        const decommissioned = vpsCheckAvailable
          ? domainsGoneMissing.filter((d) => !vpsDomains.has(d.toLowerCase()))
          : domainsGoneMissing;

        if (migratedToVps.length > 0) {
          const { error: vpsError } = await supabase
            .from('hosting_websites')
            .update({ deleted_at: now, is_decommissioned: false })
            .eq('order_id', orderId)
            .in('domain', migratedToVps);
          if (vpsError) throw vpsError;
        }
        if (decommissioned.length > 0) {
          const { error: decommissionError } = await supabase
            .from('hosting_websites')
            .update({ deleted_at: now, is_decommissioned: true })
            .eq('order_id', orderId)
            .in('domain', decommissioned);
          if (decommissionError) throw decommissionError;
        }

        for (const domain of domainsGoneMissing) {
          deletedEvents.push({ domain, order_id: orderId });
          eventsToInsert.push({
            event_type: 'site_deleted',
            domain,
            order_id: orderId,
            detail: { platform, is_decommissioned: decommissioned.includes(domain) },
          });
        }
      }
    }

    // 2. Cloud/CloudLinux hosting orders
    for (const order of hostingOrders.data ?? []) {
      const websites = await fetchAllPages<HostingerWebsite>(
        '/hosting/v1/websites',
        hostingerToken,
        `order_id=${order.id}`
      );
      await syncOrderWebsites(
        order.id,
        'cloudlinux',
        websites.map((w) => ({ domain: w.domain }))
      );

      // Subdomínio (ex: previa2.facaseusite.com.br) não conta como "site" separado
      // no contador da própria Hostinger nem contra o limite do plano - só domínios
      // principais e addon contam. Sem esse filtro o site_count ficava inflado.
      const billableWebsites = websites.filter((w) => w.vhost_type !== 'subdomain');

      const cloudPlanName = order.plan?.name ?? 'cloud_hosting';
      planSummaries.push({
        order_id: order.id,
        plan_name: cloudPlanName,
        platform: 'cloudlinux',
        site_count: billableWebsites.length,
        site_limit: KNOWN_SITE_LIMITS[cloudPlanName] ?? null,
        disk_bytes_used: null,
        disk_bytes_limit: null,
      });
    }

    // 3. Agency Plan orders
    for (const order of agencyOrders.data ?? []) {
      const websites = await fetchAllPages<AgencyWebsite>(
        '/agency-hosting/v1/websites',
        hostingerToken,
        `order_ids=${order.id}`
      );
      const normalized = websites.map((w) => {
        const domains = w.details?.domains ?? [];
        const primary = domains.find((d) => d.primary) ?? domains[0];
        return { domain: primary?.fqdn ?? '', external_uid: w.details?.uid };
      }).filter((w) => w.domain);
      await syncOrderWebsites(order.id, 'h5g', normalized);

      let diskUsed: number | null = null;
      let diskLimit: number | null = null;
      try {
        const disk = await hostingerFetch(
          `/agency-hosting/v1/orders/${order.id}/disk-usage-metrics?time_frame_days=1`,
          hostingerToken
        );
        diskLimit = disk.limits?.disk_bytes ?? null;
        const metrics = disk.metrics ?? [];
        diskUsed = metrics.length ? metrics[metrics.length - 1].disk_bytes : null;
      } catch (e) {
        console.error('Falha ao buscar disco da order', order.id, e);
      }

      const planKey = order.plan?.key ?? 'agency_growth';
      planSummaries.push({
        order_id: order.id,
        plan_name: order.plan?.name ?? planKey,
        platform: 'h5g',
        site_count: normalized.length,
        site_limit: KNOWN_SITE_LIMITS[planKey] ?? null,
        disk_bytes_used: diskUsed,
        disk_bytes_limit: diskLimit,
      });
    }

    // 4. Persistir snapshot de cada plano e o histórico de eventos, em lote.
    if (planSummaries.length > 0) {
      const { error: plansError } = await supabase
        .from('hosting_plans')
        .upsert(planSummaries.map((p) => ({ ...p, last_synced_at: now })));
      if (plansError) throw plansError;
    }
    if (eventsToInsert.length > 0) {
      const { error: eventsError } = await supabase.from('hosting_events').insert(eventsToInsert);
      if (eventsError) throw eventsError;
    }

    return new Response(
      JSON.stringify({
        success: true,
        synced_at: now,
        created: createdEvents,
        deleted: deletedEvents,
        plans: planSummaries,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('💥 Erro em hosting-sync:', error);
    const message = error instanceof Error ? error.message : 'Erro interno';
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
