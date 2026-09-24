import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { getFunctionErrorMessage } from "@/lib/functionError";
import { Mail, RefreshCw, Copy, CheckCircle2 } from "lucide-react";

export interface MailDnsSnapshot {
  real: boolean;
  mx: string[];
  spf: string | null;
  dmarc: string | null;
  hosts: Record<string, string>;
  dkim: Record<string, string>;
  source?: string;
}

export interface MailDnsAlertSite {
  id: string;
  domain: string;
  mail_dns_status: string | null;
  mail_dns_note: string | null;
  mail_dns_snapshot: MailDnsSnapshot | null;
  mail_dns_snapshot_at: string | null;
  mail_dns_checked_at: string | null;
  projects?: { id: string; client_name: string } | null;
}

// Monta a lista de registros no formato que se digita no painel de DNS
// (Tipo / Nome / Valor), pra recriar o e-mail do cliente sem adivinhação.
export function snapshotToRecords(s: MailDnsSnapshot): { type: string; name: string; value: string }[] {
  const records: { type: string; name: string; value: string }[] = [];
  for (const mx of s.mx) {
    const [priority, target] = mx.includes(" ") ? mx.split(/\s+/) : ["0", mx];
    records.push({ type: "MX", name: "@", value: `${target} (prioridade ${priority})` });
  }
  if (s.spf) records.push({ type: "TXT", name: "@", value: s.spf });
  if (s.dmarc) records.push({ type: "TXT", name: "_dmarc", value: s.dmarc });
  for (const [selector, target] of Object.entries(s.dkim ?? {})) {
    records.push({ type: "CNAME", name: `${selector}._domainkey`, value: target });
  }
  for (const [host, target] of Object.entries(s.hosts ?? {})) {
    records.push({ type: "CNAME", name: host, value: target });
  }
  return records;
}

export function MailDnsAlerts({ sites }: { sites: MailDnsAlertSite[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);

  const handleCheckNow = async () => {
    setChecking(true);
    try {
      const response = await supabase.functions.invoke("mail-dns-watch", { body: {} });
      if (response.error) {
        throw new Error(await getFunctionErrorMessage(response.error, "Erro ao checar e-mails"));
      }
      const r = response.data;
      toast({
        title: "Checagem de e-mail concluída",
        description: `${r.checked ?? 0} domínio(s) checado(s): ${r.lost ?? 0} perderam o e-mail, ${r.changed ?? 0} com MX alterado.`,
      });
      queryClient.invalidateQueries({ queryKey: ["hosting_websites"] });
    } catch (error) {
      toast({
        title: "Erro",
        description: error instanceof Error ? error.message : "Não foi possível checar os e-mails.",
        variant: "destructive",
      });
    } finally {
      setChecking(false);
    }
  };

  // "Resolvido" limpa o snapshot: a próxima checagem passa a considerar a
  // configuração atual como a correta (ex.: cliente trocou de provedor de
  // e-mail de propósito, ou o domínio deixou de usar e-mail).
  const handleResolve = async (domain: string) => {
    setResolving(domain);
    const { error } = await supabase
      .from("hosting_websites")
      .update({ mail_dns_status: null, mail_dns_note: null, mail_dns_snapshot: null, mail_dns_snapshot_at: null })
      .eq("domain", domain);
    setResolving(null);
    if (error) {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Marcado como resolvido", description: domain });
    queryClient.invalidateQueries({ queryKey: ["hosting_websites"] });
  };

  const copyRecords = async (site: MailDnsAlertSite) => {
    if (!site.mail_dns_snapshot) return;
    const text = snapshotToRecords(site.mail_dns_snapshot)
      .map((r) => `${r.type}\t${r.name}\t${r.value}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Registros copiados" });
    } catch {
      toast({ title: "Não foi possível copiar", variant: "destructive" });
    }
  };

  return (
    <Card className="border-red-500/30">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm font-medium flex items-center gap-1.5 text-red-600">
            <Mail className="h-4 w-4" />
            E-mail de cliente com problema ({sites.length})
          </CardTitle>
          <Button size="sm" variant="outline" onClick={handleCheckNow} disabled={checking}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${checking ? "animate-spin" : ""}`} />
            Checar agora
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Domínios que tinham e-mail configurado (MX de UOL, Locaweb, Google, Hostinger do cliente...) e perderam a
          configuração — geralmente porque a DNS foi apagada ao excluir o site da Hostinger ou editada numa migração.
          Checado no DNS público a cada 3 horas. Os registros abaixo são os últimos vistos funcionando: recrie-os na DNS
          do domínio.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {sites.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Nenhum e-mail de cliente com problema. 🎉</p>
        ) : (
          sites.map((site) => (
            <div key={site.id} className="rounded-md border p-3 space-y-2">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium">{site.domain}</p>
                    {site.mail_dns_status === "lost" ? (
                      <Badge className="bg-red-600 hover:bg-red-600">E-mail fora do ar</Badge>
                    ) : (
                      <Badge className="bg-amber-500 hover:bg-amber-500">MX alterado</Badge>
                    )}
                  </div>
                  {site.projects ? (
                    <Link to={`/projeto/${site.projects.id}`} className="text-xs text-primary hover:underline">
                      {site.projects.client_name}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">Sem projeto vinculado</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => copyRecords(site)}>
                    <Copy className="h-3.5 w-3.5 mr-1" /> Copiar registros
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleResolve(site.domain)}
                    disabled={resolving === site.domain}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Marcar como resolvido
                  </Button>
                </div>
              </div>
              {site.mail_dns_note && <p className="text-xs text-red-600">{site.mail_dns_note}</p>}
              {site.mail_dns_snapshot && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr className="text-muted-foreground text-left">
                        <th className="pr-3 font-normal">Tipo</th>
                        <th className="pr-3 font-normal">Nome</th>
                        <th className="font-normal">Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshotToRecords(site.mail_dns_snapshot).map((r, i) => (
                        <tr key={i}>
                          <td className="pr-3">{r.type}</td>
                          <td className="pr-3">{r.name}</td>
                          <td className="break-all">{r.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                Configuração vista funcionando em{" "}
                {site.mail_dns_snapshot_at ? new Date(site.mail_dns_snapshot_at).toLocaleString("pt-BR") : "—"}
                {site.mail_dns_snapshot?.source ? ` (${site.mail_dns_snapshot.source})` : ""} · última checagem{" "}
                {site.mail_dns_checked_at ? new Date(site.mail_dns_checked_at).toLocaleString("pt-BR") : "—"}
              </p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
