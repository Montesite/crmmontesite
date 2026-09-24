ALTER TABLE hosting_websites
  ADD COLUMN IF NOT EXISTS mail_dns_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS mail_dns_snapshot_at timestamptz,
  ADD COLUMN IF NOT EXISTS mail_dns_status text,
  ADD COLUMN IF NOT EXISTS mail_dns_note text,
  ADD COLUMN IF NOT EXISTS mail_dns_checked_at timestamptz;

COMMENT ON COLUMN hosting_websites.mail_dns_snapshot IS 'Última configuração de e-mail conhecida e válida do domínio, lida do DNS público pela função mail-dns-watch: { mx: string[], spf, dmarc, hosts: {mail, smtp, imap...: destino}, dkim: {seletor: destino}, real: boolean }. É o "como era" pra recriar os registros se o e-mail do cliente cair (ex.: DNS apagada ao excluir o site da Hostinger).';
COMMENT ON COLUMN hosting_websites.mail_dns_status IS 'ok = e-mail do cliente configurado e igual ao snapshot; no_mail = domínio não tem e-mail real (sem MX ou só o MX padrão da Hostinger); lost = tinha e-mail e o MX sumiu; changed = MX diferente do snapshot. lost/changed aparecem na aba "E-mail" da Hospedagem.';

-- Baseline dos dois domínios que já perderam o e-mail na exclusão de
-- 2026-09-22 (DNS apagada junto com o site da Hostinger) - lido dos
-- snapshots de DNS da Hostinger (182604280 e 182604373). Sem isso eles nunca
-- apareceriam no aviso, porque a checagem só compara com o que já viu.
UPDATE hosting_websites
SET mail_dns_snapshot = '{
  "real": true,
  "mx": ["10 mx2.hostinger.com", "5 mx1.hostinger.com"],
  "spf": "v=spf1 include:_spf.mail.hostinger.com ~all",
  "dmarc": "v=DMARC1; p=none",
  "hosts": {"autodiscover": "autodiscover.mail.hostinger.com", "autoconfig": "autoconfig.mail.hostinger.com"},
  "dkim": {
    "hostingermail-a": "hostingermail-a.dkim.mail.hostinger.com",
    "hostingermail-b": "hostingermail-b.dkim.mail.hostinger.com",
    "hostingermail-c": "hostingermail-c.dkim.mail.hostinger.com"
  },
  "source": "snapshot DNS Hostinger de 2026-09-22 (antes da exclusão)"
}'::jsonb,
  mail_dns_snapshot_at = '2026-09-22T18:53:00Z'
WHERE domain IN ('sorveteslimel.com.br', 'vitrineorganicosjuquitiba.com.br')
  AND mail_dns_snapshot IS NULL;
