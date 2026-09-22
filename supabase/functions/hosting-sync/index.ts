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

// O painel AdminBolt da VPS serve só o certificado da própria (ZeroSSL RSA DV
// SSL CA 2), sem a cadeia intermediária - Deno recusa a conexão por padrão
// ("unable to verify the first certificate"). Fornece explicitamente o
// intermediário e a raiz da Sectigo (baixados de crt.sectigo.com via AIA do
// certificado da própria VPS) pra completar a cadeia; não desliga verificação
// nenhuma, só supre o elo que o servidor deveria estar enviando e não envia.
const ZEROSSL_INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIIGITCCBAmgAwIBAgIRANCpCCVfjlDl8zltERRwKjcwDQYJKoZIhvcNAQEMBQAw
XzELMAkGA1UEBhMCR0IxGDAWBgNVBAoTD1NlY3RpZ28gTGltaXRlZDE2MDQGA1UE
AxMtU2VjdGlnbyBQdWJsaWMgU2VydmVyIEF1dGhlbnRpY2F0aW9uIFJvb3QgUjQ2
MB4XDTI1MDkyNDAwMDAwMFoXDTM1MDkyMzIzNTk1OVowRjELMAkGA1UEBhMCQVQx
FTATBgNVBAoTDFplcm9TU0wgR21iSDEgMB4GA1UEAxMXWmVyb1NTTCBSU0EgRFYg
U1NMIENBIDIwggGiMA0GCSqGSIb3DQEBAQUAA4IBjwAwggGKAoIBgQCnXX3Qm/G+
ujylvYIkhJ53ZZ7XM03vXY03sCnO9VWjwMsV0qCQMlvhuRiJwrm4M5jgGehxIiCR
1qT0AyL2rHTWJR07vjJzuNmp7uoKu3HKwixBk9QuXD5aliO8/EDbzdZDcG/Hm5pC
mOeusLtds/UE/Iq24nw5WpcgZE5Ly+F/yCYDuEa7hXLJAPM5SecJIblG1OQ3ukMl
HHNBbDxBpGWTyDudd0DTed0NTgCPs1t8RZPhW9Gt/8nDwFX0pQ4eHfPEB8c6eNl2
sRr2Afp1YErakR+53yEX2SXc2Kz0fbTlUc+To0ULGcJiWNyZwj//DTZ+M4xxsT2T
qjQ4Xfvm2EUTymrXDrh1Pm/wkBouu860c6eeQfNlKlccUyHOSeKCtPIWreMvH3Be
Ydeu3DwI8lefn/VUhSB2Bbz7hX3qz3oMmtSTmWhTnobyKlx1L2b/oloaqpy1cBc/
QiLRSOptYGPjZtX0pRrTVKQXeP2rPUk0y5q/40WRpugSlHCX6aceWnsCAwEAAaOC
AW8wggFrMB8GA1UdIwQYMBaAFFZzWGSV+ZIasBIqBGJ5oUAViCFJMB0GA1UdDgQW
BBRLvvp2hCNEBLnOvjFv6fUyBv8MVzAOBgNVHQ8BAf8EBAMCAYYwEgYDVR0TAQH/
BAgwBgEB/wIBADATBgNVHSUEDDAKBggrBgEFBQcDATATBgNVHSAEDDAKMAgGBmeB
DAECATBUBgNVHR8ETTBLMEmgR6BFhkNodHRwOi8vY3JsLnNlY3RpZ28uY29tL1Nl
Y3RpZ29QdWJsaWNTZXJ2ZXJBdXRoZW50aWNhdGlvblJvb3RSNDYuY3JsMIGEBggr
BgEFBQcBAQR4MHYwTwYIKwYBBQUHMAKGQ2h0dHA6Ly9jcnQuc2VjdGlnby5jb20v
U2VjdGlnb1B1YmxpY1NlcnZlckF1dGhlbnRpY2F0aW9uUm9vdFI0Ni5wN2MwIwYI
KwYBBQUHMAGGF2h0dHA6Ly9vY3NwLnNlY3RpZ28uY29tMA0GCSqGSIb3DQEBDAUA
A4ICAQCJ/3v2/vdexHsdVyXL9aCTQE01YXl23866TVM/LgRpRW+kneZXXZxP0hy4
GnvlqUcxTq97B6qPdQcQxQxpGne7CRn0nWauzqieMcJzYl3fDC2Q/ANyPhyrbwCI
zx9EsRrgfjvuJCaUMtlfYpKqBUYiPOCPAN0HdrLD5hU6oV1tvWVsUzTA43skC3uH
wQM5YPIk0NDJFw3NhQPOIOwbq09T+SYSEZvsJ3t4sA4H3gh03RETNaAwTcTNS/+u
1tAeQUZZmKQyLWYLyoxvbISp/MFr9xqhDqrpAurYVNeiLJ5+4/WZPml20yNZjcxV
KKqRYdEurl8rmI2toCnCDWiEcTDvoYGtz60eYIt7VJID4DrCjTxAWTWh2T5ag2pK
ryNJGt8BFGLtjeD774SxAFn5MGYBVvEK4LXmCjVX78pb6/0Dceo71dlQUK68yftb
+yTeyoqjwgk2L8vNSrkj6UTkvvqXSONFuVU7bvC0O/9bi5MXBv7QUivMNxDsTtaT
IZO7PsSCRmLraQM2EPBgbNL9lRSEYi4Hj+NicT/e87pbhv88k0oec9xGcnkcvZpN
sJBz78mkZfeFIIjh02e2y9ke/Fqw1FbdhHtU2myaFnX0sRyGLmI/vzXSwyvT+Kxl
Wx8FV64z2PBdwd0vXRaAMXomGC0M1vQa5fBDn4dimzewsSiphQ==
-----END CERTIFICATE-----`;

const SECTIGO_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIFijCCA3KgAwIBAgIQdY39i658BwD6qSWn4cetFDANBgkqhkiG9w0BAQwFADBf
MQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQD
Ey1TZWN0aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYw
HhcNMjEwMzIyMDAwMDAwWhcNNDYwMzIxMjM1OTU5WjBfMQswCQYDVQQGEwJHQjEY
MBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQDEy1TZWN0aWdvIFB1Ymxp
YyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYwggIiMA0GCSqGSIb3DQEB
AQUAA4ICDwAwggIKAoICAQCTvtU2UnXYASOgHEdCSe5jtrch/cSV1UgrJnwUUxDa
ef0rty2k1Cz66jLdScK5vQ9IPXtamFSvnl0xdE8H/FAh3aTPaE8bEmNtJZlMKpnz
SDBh+oF8HqcIStw+KxwfGExxqjWMrfhu6DtK2eWUAtaJhBOqbchPM8xQljeSM9xf
iOefVNlI8JhD1mb9nxc4Q8UBUQvX4yMPFF1bFOdLvt30yNoDN9HWOaEhUTCDsG3X
ME6WW5HwcCSrv0WBZEMNvSE6Lzzpng3LILVCJ8zab5vuZDCQOc2TZYEhMbUjUDM3
IuM47fgxMMxF/mL50V0yeUKH32rMVhlATc6qu/m1dkmU8Sf4kaWD5QazYw6A3OAS
VYCmO2a0OYctyPDQ0RTp5A1NDvZdV3LFOxxHVp3i1fuBYYzMTYCQNFu31xR13NgE
SJ/AwSiItOkcyqex8Va3e0lMWeUgFaiEAin6OJRpmkkGj80feRQXEgyDet4fsZfu
+Zd4KKTIRJLpfSYFplhym3kT2BFfrsU4YjRosoYwjviQYZ4ybPUHNs2iTG7sijbt
8uaZFURww3y8nDnAtOFr94MlI1fZEoDlSfB1D++N6xybVCi0ITz8fAr/73trdf+L
HaAZBav6+CuBQug4urv7qv094PPK306Xlynt8xhW6aWWrL3DkJiy4Pmi1KZHQ3xt
zwIDAQABo0IwQDAdBgNVHQ4EFgQUVnNYZJX5khqwEioEYnmhQBWIIUkwDgYDVR0P
AQH/BAQDAgGGMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEMBQADggIBAC9c
mTz8Bl6MlC5w6tIyMY208FHVvArzZJ8HXtXBc2hkeqK5Duj5XYUtqDdFqij0lgVQ
YKlJfp/imTYpE0RHap1VIDzYm/EDMrraQKFz6oOht0SmDpkBm+S8f74TlH7Kph52
gDY9hAaLMyZlbcp+nv4fjFg4exqDsQ+8FxG75gbMY/qB8oFM2gsQa6H61SilzwZA
Fv97fRheORKkU55+MkIQpiGRqRxOF3yEvJ+M0ejf5lG5Nkc/kLnHvALcWxxPDkjB
JYOcCj+esQMzEhonrPcibCTRAUH4WAP+JWgiH5paPHxsnnVI84HxZmduTILA7rpX
DhjvLpr3Etiga+kFpaHpaPi8TD8SHkXoUsCjvxInebnMMTzD9joiFgOgyY9mpFui
TdaBJQbpdqQACj7LzTWb4OE4y2BThihCQRxEV+ioratF4yUQvNs+ZUH7G6aXD+u5
dHn5HrwdVw1Hr8Mvn4dGp+smWg9WY7ViYG4A++MnESLn/pmPNPW56MORcr3Ywx65
LvKRRFHQV80MNNVIIb/bE/FmJUNS0nAiNs2fxBx1IK1jcmMGDw4nztJqDby1ORrp
0XZ60Vzk50lJLVU3aPAaOpg+VBeHVOmmJ1CJeyAvP/+/oYtKR5j/K3tJPsMpRmAY
QqszKbrAKbkTidOIijlBO8n9pu0f9GBj39ItVQGL
-----END CERTIFICATE-----`;

// Consulta a lista real de contas na VPS AdminBolt, pra saber se um site que
// sumiu da Hostinger foi realmente migrado pra lá (deleted_at + ainda "vps")
// ou se foi removido por outro motivo (deleted_at + is_decommissioned = true).
// Sem isso não dava pra distinguir os dois casos - qualquer site que saísse
// da Hostinger virava "Migrado p/ VPS" por padrão, estivesse ele lá ou não.
//
// A VPS foi reinstalada em 2026-09-22 (AdminBolt trocado por HestiaCP, que
// exigia licença paga) - o endpoint do AdminBolt não existe mais e nunca vai
// responder de novo. Sem timeout aqui, o fetch ficava pendurado até o limite
// de tempo da própria function (bem além dos 60-120s de qualquer chamador),
// travando o hosting-sync inteiro - inclusive a reclassificação de sites que
// não têm nada a ver com a VPS. Com o timeout, a chamada falha rápido e cai
// no fallback (vpsDomains vazio) normalmente. TODO: trocar esse endpoint pelo
// equivalente do HestiaCP assim que os sites forem recriados lá.
async function fetchVpsDomains(apiUrl: string, apiKey: string, apiSecret: string): Promise<Set<string>> {
  const client = Deno.createHttpClient({ caCerts: [ZEROSSL_INTERMEDIATE_PEM, SECTIGO_ROOT_PEM] });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${apiUrl}/api/hosting-accounts?per_page=200`, {
      client,
      signal: controller.signal,
      headers: { 'X-API-Key': apiKey, 'X-API-Secret': apiSecret, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`AdminBolt API /hosting-accounts -> HTTP ${res.status}`);
    }
    const data = await res.json();
    const accounts: { domain: string }[] = Array.isArray(data) ? data : data.data ?? [];
    return new Set(accounts.map((a) => a.domain.toLowerCase()));
  } finally {
    clearTimeout(timer);
    client.close();
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

    // Opcional: se os secrets do AdminBolt não estiverem configurados, a
    // classificação cai de volta pro comportamento antigo (fica "vps" por
    // padrão) - registra no log pra ficar visível que a checagem foi pulada.
    const adminboltUrl = Deno.env.get('ADMINBOLT_API_URL');
    const adminboltKey = Deno.env.get('ADMINBOLT_API_KEY');
    const adminboltSecret = Deno.env.get('ADMINBOLT_API_SECRET');
    let vpsDomains = new Set<string>();
    if (adminboltUrl && adminboltKey && adminboltSecret) {
      try {
        vpsDomains = await fetchVpsDomains(adminboltUrl, adminboltKey, adminboltSecret);
      } catch (e) {
        console.error('Falha ao buscar contas da VPS AdminBolt - sites removidos da Hostinger não serão reclassificados corretamente nesta execução:', e);
      }
    } else {
      console.error('ADMINBOLT_API_URL/KEY/SECRET não configurados - pulando checagem de VPS.');
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
        // O AdminBolt saiu do ar de vez em 2026-09-22 (ver comentário em
        // fetchVpsDomains) - vpsDomains fica sempre vazio agora, então
        // vpsCheckAvailable é sempre false na prática. Com a migração pra
        // VPS já concluída (11 sites migrados naquele mesmo dia, ver
        // MIGRACOES.md), todo domínio que some da Hostinger hoje em diante é
        // overwhelmingly um cancelamento, não uma nova migração - por isso o
        // fallback (sem checagem de VPS disponível) agora é "decommissioned",
        // não "migrado pra VPS". Antes disso, esse fallback tratava tudo como
        // "migrado pra VPS" por padrão e chegou a classificar ~30 sites
        // deletados manualmente da Hostinger em 2026-09-22 (achado auditando
        // o pedido do usuário sobre os domínios lelepepe que ele excluiu) como
        // "Migrado p/ VPS" quando na verdade foram apenas cancelados.
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
