import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Achado em 2026-09-24: ao excluir da Hostinger sites já migrados pra VPS, a
// DNS de 15 domínios foi apagada junto - inclusive o MX que apontava pro
// e-mail do cliente (UOL, Hostinger do próprio cliente etc.), que ficou dias
// fora do ar sem ninguém perceber. Essa função guarda a última configuração
// de e-mail vista de cada domínio e avisa quando ela some ou muda, seja qual
// for o caminho (hPanel, migração, exclusão pelo CRM, cliente mexendo na DNS).
//
// Lê o DNS PÚBLICO (DoH da Cloudflare), não a API da Hostinger: enxerga
// qualquer provedor de DNS (não só a nossa conta) e não sofre com o
// rate-limit da API da Hostinger, que bloqueia por dezenas de minutos.
const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const BATCH_SIZE = 150;
const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 6000;

// Subdomínios de acesso ao e-mail que costumam existir quando o cliente usa
// um provedor de e-mail (UOL, Locaweb, Hostinger, Google...).
const MAIL_HOSTS = ['mail', 'smtp', 'imap', 'pop', 'pop3', 'webmail', 'autodiscover', 'autoconfig'];
// DKIM não dá pra listar - testa os seletores dos provedores que aparecem na
// nossa base (UOL = pro, Hostinger = hostingermail-*, Google, Microsoft).
const DKIM_SELECTORS = ['pro', 'default', 'hostingermail-a', 'hostingermail-b', 'hostingermail-c', 'google', 'selector1', 'selector2'];

interface MailDnsConfig {
  real: boolean;
  mx: string[];
  spf: string | null;
  dmarc: string | null;
  hosts: Record<string, string>;
  dkim: Record<string, string>;
}

class DnsLookupError extends Error {}

interface DohAnswer {
  type: number;
  data: string;
}

async function doh(name: string, type: string): Promise<{ nxdomain: boolean; answers: DohAnswer[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new DnsLookupError(`DoH ${name} ${type} -> HTTP ${res.status}`);
    const data = await res.json();
    // 0 = NOERROR, 3 = NXDOMAIN; qualquer outro (SERVFAIL etc.) é falha de
    // consulta, não "não tem registro" - não pode virar alarme de e-mail perdido.
    if (data.Status === 3) return { nxdomain: true, answers: [] };
    if (data.Status !== 0) throw new DnsLookupError(`DoH ${name} ${type} -> status ${data.Status}`);
    return { nxdomain: false, answers: Array.isArray(data.Answer) ? data.Answer : [] };
  } catch (e) {
    if (e instanceof DnsLookupError) throw e;
    throw new DnsLookupError(`DoH ${name} ${type} -> ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

const stripDot = (s: string) => s.replace(/\.$/, '').toLowerCase();
const unquoteTxt = (s: string) => s.replace(/^"|"$/g, '').replace(/"\s*"/g, '');
const DNS_TYPE_CNAME = 5;

// Só o MX padrão que a Hostinger cria sozinha pra todo site hospedado - sem
// DKIM do e-mail Hostinger, é sinal de que ninguém usa e-mail no domínio
// (nós não temos caixa de cliente na nossa conta).
function isHostingerDefaultMx(mx: string) {
  return /\bmx[12]\.hostinger\.com(\.br)?$/i.test(mx);
}

async function readMailDns(domain: string): Promise<{ nxdomain: boolean; config: MailDnsConfig }> {
  const mxRes = await doh(domain, 'MX');
  const empty: MailDnsConfig = { real: false, mx: [], spf: null, dmarc: null, hosts: {}, dkim: {} };
  if (mxRes.nxdomain) return { nxdomain: true, config: empty };

  const mx = mxRes.answers.filter((a) => a.type === 15).map((a) => stripDot(a.data)).sort();

  const [txtRes, dmarcRes, hostResults, dkimResults] = await Promise.all([
    doh(domain, 'TXT'),
    doh(`_dmarc.${domain}`, 'TXT'),
    Promise.all(MAIL_HOSTS.map(async (h) => [h, await doh(`${h}.${domain}`, 'CNAME')] as const)),
    Promise.all(DKIM_SELECTORS.map(async (s) => [s, await doh(`${s}._domainkey.${domain}`, 'CNAME')] as const)),
  ]);

  const spf = txtRes.answers.map((a) => unquoteTxt(a.data)).find((t) => /^v=spf1/i.test(t)) ?? null;
  const dmarc = dmarcRes.answers.map((a) => unquoteTxt(a.data)).find((t) => /^v=DMARC1/i.test(t)) ?? null;
  const hosts: Record<string, string> = {};
  for (const [h, r] of hostResults) {
    const cname = r.answers.find((a) => a.type === DNS_TYPE_CNAME);
    if (cname) hosts[h] = stripDot(cname.data);
  }
  const dkim: Record<string, string> = {};
  for (const [s, r] of dkimResults) {
    const cname = r.answers.find((a) => a.type === DNS_TYPE_CNAME);
    if (cname) dkim[s] = stripDot(cname.data);
  }

  const onlyHostingerDefault = mx.length > 0 && mx.every(isHostingerDefaultMx);
  const hasHostingerMailDkim = Object.keys(dkim).some((s) => s.startsWith('hostingermail-'));
  const real = mx.length > 0 && (!onlyHostingerDefault || hasHostingerMailDkim);

  return { nxdomain: false, config: { real, mx, spf, dmarc, hosts, dkim } };
}

function mxTargets(mx: string[]) {
  return mx.map((m) => m.split(/\s+/).pop() ?? m).sort().join(', ');
}

interface SiteRow {
  id: string;
  domain: string;
  mail_dns_snapshot: (MailDnsConfig & { source?: string }) | null;
  mail_dns_status: string | null;
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const cronSecret = Deno.env.get('CRON_SYNC_SECRET');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const authorized = (!!cronSecret && bearer === cronSecret) || (!!anonKey && bearer === anonKey);
    if (!authorized) {
      return new Response(JSON.stringify({ success: false, error: 'Não autorizado' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Todo domínio conhecido, inclusive os excluídos/migrados - o e-mail do
    // cliente continua existindo depois que o site sai da Hostinger, e é
    // justamente nessa hora que ele costuma cair.
    const { data: sites, error } = await supabase
      .from('hosting_websites')
      .select('id, domain, mail_dns_snapshot, mail_dns_status')
      .eq('is_placeholder', false)
      .order('mail_dns_checked_at', { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE);
    if (error) throw error;

    const now = new Date().toISOString();
    const counts = { checked: 0, ok: 0, no_mail: 0, lost: 0, changed: 0, lookup_failed: 0 };

    await mapWithConcurrency((sites ?? []) as SiteRow[], CONCURRENCY, async (site) => {
      const domain = site.domain.toLowerCase().replace(/^www\./, '');
      let result: Awaited<ReturnType<typeof readMailDns>>;
      try {
        result = await readMailDns(domain);
      } catch (e) {
        // Falha de consulta não muda o status (nem apaga o snapshot) - só
        // registra que passou, pra rodada seguinte tentar os próximos.
        counts.lookup_failed += 1;
        console.error(`mail-dns-watch: falha ao consultar ${domain}:`, e);
        await supabase.from('hosting_websites').update({ mail_dns_checked_at: now }).eq('id', site.id);
        return;
      }
      counts.checked += 1;

      const { nxdomain, config } = result;
      const snapshot = site.mail_dns_snapshot;
      const update: Record<string, unknown> = { mail_dns_checked_at: now };

      if (config.real) {
        if (snapshot?.real && mxTargets(snapshot.mx) !== mxTargets(config.mx)) {
          // Mantém o snapshot antigo (é ele que diz como era) até alguém
          // marcar como resolvido na aba "E-mail".
          update.mail_dns_status = 'changed';
          update.mail_dns_note = `MX mudou de ${mxTargets(snapshot.mx)} para ${mxTargets(config.mx)} - confirme se o cliente trocou de provedor de e-mail.`;
          counts.changed += 1;
        } else {
          update.mail_dns_status = 'ok';
          update.mail_dns_note = null;
          update.mail_dns_snapshot = config;
          update.mail_dns_snapshot_at = now;
          counts.ok += 1;
        }
      } else if (snapshot?.real) {
        update.mail_dns_status = 'lost';
        update.mail_dns_note = nxdomain
          ? `A DNS do domínio não existe mais (NXDOMAIN) - o e-mail (${mxTargets(snapshot.mx)}) parou de receber. Recrie a DNS com os registros abaixo.`
          : config.mx.length === 0
          ? `O MX sumiu da DNS - o e-mail (${mxTargets(snapshot.mx)}) parou de receber. Recrie os registros abaixo.`
          : `O MX agora é só o padrão da Hostinger (${mxTargets(config.mx)}) em vez de ${mxTargets(snapshot.mx)} - o e-mail do cliente parou de receber. Recrie os registros abaixo.`;
        counts.lost += 1;
      } else {
        update.mail_dns_status = 'no_mail';
        update.mail_dns_note = null;
        counts.no_mail += 1;
      }

      await supabase.from('hosting_websites').update(update).eq('id', site.id);
    });

    return new Response(JSON.stringify({ success: true, checked_at: now, sites: sites?.length ?? 0, ...counts }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('💥 Erro em mail-dns-watch:', error);
    const message = error instanceof Error ? error.message : 'Erro interno';
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
