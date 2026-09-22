ALTER TABLE hosting_websites
  ADD COLUMN IF NOT EXISTS domain_registered_by_us boolean;

COMMENT ON COLUMN hosting_websites.domain_registered_by_us IS 'true = domínio está no portfólio da nossa própria conta Hostinger (GET /domains/v1/portfolio) - por política interna, esses ficam com renovação automática habilitada e só são desativados no processo de cancelamento do cliente. false = domínio de terceiro (cliente registrou em outro lugar, ou em conta Hostinger separada dele) - só aponta pra nossa hospedagem, nós não controlamos a renovação. null = ainda não checado.';
