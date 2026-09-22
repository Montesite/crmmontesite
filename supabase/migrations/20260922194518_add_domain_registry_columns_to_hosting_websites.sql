ALTER TABLE hosting_websites
  ADD COLUMN IF NOT EXISTS domain_registry_status text,
  ADD COLUMN IF NOT EXISTS domain_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS domain_nameservers text,
  ADD COLUMN IF NOT EXISTS domain_checked_at timestamptz;

COMMENT ON COLUMN hosting_websites.domain_registry_status IS 'Status cru do RDAP do registro.br pro domínio (active/inactive/not_registered/check_failed) - só preenchido pra domínios .br que já caíram em needs_client_action.';
COMMENT ON COLUMN hosting_websites.domain_expires_at IS 'Data de expiração do registro do domínio, segundo o RDAP do registro.br.';
COMMENT ON COLUMN hosting_websites.domain_nameservers IS 'Nameservers do domínio, segundo o RDAP do registro.br (lista separada por vírgula).';
COMMENT ON COLUMN hosting_websites.domain_checked_at IS 'Quando o RDAP do registro.br foi consultado pela última vez pra esse domínio.';
