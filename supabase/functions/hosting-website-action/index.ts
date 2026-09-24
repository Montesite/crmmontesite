import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const HOSTINGER_API_BASE = 'https://developers.hostinger.com/api';

async function hostingerFetch(
  path: string,
  token: string,
  init: RequestInit = {}
) {
  const res = await fetch(`${HOSTINGER_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Hostinger API ${path} -> HTTP ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

interface DnsRecord {
  name: string;
  type: string;
  content: string;
}

interface DnsRiskReport {
  in_portfolio: boolean;
  zone_records: DnsRecord[];
  mail_records: DnsRecord[];
  at_risk: boolean;
}

const MAIL_RECORD_NAME = /^(mail|smtp|imap|pop3?|webmail|autodiscover|autoconfig|_autodiscover\._tcp|_dmarc)$|_domainkey$/i;

function isMailRecord(r: DnsRecord): boolean {
  if (r.type === 'MX') return true;
  if (r.type === 'TXT' && /v=spf1/i.test(r.content)) return true;
  return MAIL_RECORD_NAME.test(r.name);
}

// Achado em 2026-09-24: ao excluir da Hostinger sites já migrados pra VPS, 15
// domínios perderam a DNS inteira (inclusive o MX que apontava pro e-mail do
// cliente na UOL, Hostinger do cliente etc.) - quando o domínio não está no
// portfólio de Domínios da nossa conta, a zona DNS existe só como parte do
// site hospedado e é apagada junto com ele. Os que estão no portfólio mantêm
// a zona. Esse relatório é mostrado antes de excluir pra ninguém apagar a DNS
// de um cliente sem perceber.
async function buildDnsRiskReport(domain: string, token: string): Promise<DnsRiskReport> {
  const host = domain.toLowerCase().replace(/^www\./, '');
  const portfolio = await hostingerFetch('/domains/v1/portfolio', token);
  const inPortfolio = (Array.isArray(portfolio) ? portfolio : portfolio?.data ?? []).some(
    (d: { domain?: string }) => {
      const owned = (d.domain ?? '').toLowerCase();
      return !!owned && (host === owned || host.endsWith(`.${owned}`));
    }
  );

  let zone: { name: string; type: string; records: { content: string }[] }[] = [];
  try {
    zone = (await hostingerFetch(`/dns/v1/zones/${encodeURIComponent(host)}`, token)) ?? [];
  } catch (e) {
    // 404 = domínio sem zona na nossa conta (DNS fica em outro provedor) -
    // excluir o site não mexe em DNS nenhuma, então não há risco.
    if (!(e instanceof Error && /HTTP 404/.test(e.message))) throw e;
  }
  const zoneRecords: DnsRecord[] = zone.flatMap((z) =>
    (z.records ?? []).map((r) => ({ name: z.name, type: z.type, content: r.content }))
  );
  const mailRecords = zoneRecords.filter(isMailRecord);

  return {
    in_portfolio: inPortfolio,
    zone_records: zoneRecords,
    mail_records: mailRecords,
    at_risk: !inPortfolio && zoneRecords.length > 0,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Não há sessão de usuário real do Supabase Auth neste CRM (login é uma flag
    // local no navegador); o gateway do Supabase (verify_jwt padrão desta função)
    // já garante que o caller possui a chave anon/service do projeto.
    const actorEmail = 'painel-hospedagem';

    const hostingerToken = Deno.env.get('HOSTINGER_API_TOKEN');
    if (!hostingerToken) {
      return new Response(
        JSON.stringify({ success: false, error: 'HOSTINGER_API_TOKEN não configurado' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { website_id, action, confirm_dns_loss } = await req.json();
    if (!website_id || !['deactivate', 'reactivate', 'delete', 'delete_precheck', 'clear_cache'].includes(action)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Parâmetros inválidos' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: site, error: siteError } = await supabase
      .from('hosting_websites')
      .select('*')
      .eq('id', website_id)
      .single();

    if (siteError || !site) {
      return new Response(
        JSON.stringify({ success: false, error: 'Site não encontrado' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if ((action === 'deactivate' || action === 'reactivate') && site.platform !== 'h5g') {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Tirar do ar / reativar só está disponível para sites do plano Agency Growth.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'delete_precheck') {
      const report = await buildDnsRiskReport(site.domain, hostingerToken);
      return new Response(JSON.stringify({ success: true, ...report }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const now = new Date().toISOString();

    if (action === 'deactivate') {
      await hostingerFetch(
        `/agency-hosting/v1/websites/${site.external_uid}/domains/${site.domain}`,
        hostingerToken,
        { method: 'DELETE' }
      );
      await supabase.from('hosting_websites').update({ panel_state: 'offline' }).eq('id', website_id);
      await supabase.from('hosting_events').insert({
        event_type: 'site_deactivated',
        domain: site.domain,
        order_id: site.order_id,
        detail: { actor_email: actorEmail },
      });
    } else if (action === 'reactivate') {
      await hostingerFetch(
        `/agency-hosting/v1/websites/${site.external_uid}/domains`,
        hostingerToken,
        { method: 'POST', body: JSON.stringify({ domain: site.domain, primary: true }) }
      );
      await supabase.from('hosting_websites').update({ panel_state: 'active' }).eq('id', website_id);
      await supabase.from('hosting_events').insert({
        event_type: 'site_reactivated',
        domain: site.domain,
        order_id: site.order_id,
        detail: { actor_email: actorEmail },
      });
    } else if (action === 'delete') {
      // Refaz a checagem aqui (não confia só no que a tela mostrou) - sem a
      // confirmação explícita, não exclui um site cuja DNS some junto.
      const report = await buildDnsRiskReport(site.domain, hostingerToken);
      if (report.at_risk && confirm_dns_loss !== true) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `A DNS de ${site.domain} será apagada junto com o site (domínio fora do portfólio da Hostinger). Confirme que ela foi copiada pra outro lugar antes de excluir.`,
            ...report,
          }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (site.platform === 'h5g') {
        await hostingerFetch(`/agency-hosting/v1/websites/${site.external_uid}`, hostingerToken, {
          method: 'DELETE',
        });
      } else {
        await hostingerFetch(`/hosting/v1/websites/${encodeURIComponent(site.domain)}`, hostingerToken, {
          method: 'DELETE',
        });
      }
      // Exclusão manual pelo painel nunca é uma migração pra VPS — o site não
      // tem mais hospedagem em lugar nenhum a partir daqui.
      await supabase.from('hosting_websites').update({ deleted_at: now, is_decommissioned: true }).eq('id', website_id);
      await supabase.from('hosting_events').insert({
        event_type: 'site_deleted_manual',
        domain: site.domain,
        order_id: site.order_id,
        detail: {
          actor_email: actorEmail,
          platform: site.platform,
          dns_zone_lost: report.at_risk,
          // Guarda a zona como estava - se alguém excluiu sem copiar a DNS,
          // dá pra recriar os registros (MX do cliente etc.) a partir daqui.
          dns_records_before_delete: report.at_risk ? report.zone_records : undefined,
        },
      });
    } else if (action === 'clear_cache') {
      if (site.platform === 'h5g') {
        await hostingerFetch(`/agency-hosting/v1/websites/${site.external_uid}/cache`, hostingerToken, {
          method: 'DELETE',
        });
      } else {
        // Cloud Professional exige o username da conta, que não guardamos —
        // busca na Hostinger pelo domínio exato antes de limpar o cache.
        const lookup = await hostingerFetch(
          `/hosting/v1/websites?domain=${encodeURIComponent(site.domain)}&per_page=100`,
          hostingerToken
        );
        const match = (lookup?.data ?? []).find(
          (w: { domain: string; username: string }) => w.domain.toLowerCase() === site.domain.toLowerCase()
        );
        if (!match) throw new Error(`Não foi possível localizar a conta do site ${site.domain} na Hostinger.`);
        await hostingerFetch(
          `/hosting/v1/accounts/${match.username}/websites/${encodeURIComponent(site.domain)}/cache/clear`,
          hostingerToken,
          { method: 'DELETE' }
        );
      }
      await supabase.from('hosting_events').insert({
        event_type: 'cache_cleared',
        domain: site.domain,
        order_id: site.order_id,
        detail: { actor_email: actorEmail, platform: site.platform },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('💥 Erro em hosting-website-action:', error);
    const message = error instanceof Error ? error.message : 'Erro interno';
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
