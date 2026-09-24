import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { PageLayout } from "@/components/layout/PageLayout";
import { AnalyticsCard } from "@/components/dashboard/AnalyticsCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  RefreshCw,
  HardDrive,
  Globe,
  PlusCircle,
  MinusCircle,
  CalendarDays,
  X,
  ChevronLeft,
  ChevronRight,
  PowerOff,
  Power,
  Link2,
  Unlink,
  Eraser,
  ShieldOff,
  Server,
  AlertTriangle,
  Github,
  CheckCircle2,
  XCircle,
  Code,
  CalendarClock,
  Phone,
  Mail,
} from "lucide-react";
import { WebsiteRowActions } from "@/components/hosting/WebsiteRowActions";
import { MailDnsAlerts, type MailDnsAlertSite } from "@/components/hosting/MailDnsAlerts";
import { getFunctionErrorMessage } from "@/lib/functionError";

const PAGE_SIZE_OPTIONS = [25, 50, 100];

const EVENT_META: Record<string, { icon: typeof PlusCircle; color: string; label: string }> = {
  site_created: { icon: PlusCircle, color: "text-green-600", label: "foi criado" },
  site_deleted: { icon: MinusCircle, color: "text-red-600", label: "foi removido (detectado na sincronização)" },
  site_deleted_manual: { icon: MinusCircle, color: "text-red-600", label: "foi excluído pelo painel" },
  site_deactivated: { icon: PowerOff, color: "text-orange-600", label: "foi tirado do ar" },
  site_reactivated: { icon: Power, color: "text-green-600", label: "foi reativado" },
  project_linked: { icon: Link2, color: "text-blue-600", label: "foi vinculado a um projeto" },
  project_unlinked: { icon: Unlink, color: "text-blue-600", label: "teve o vínculo com projeto removido" },
  cache_cleared: { icon: Eraser, color: "text-purple-600", label: "teve o cache limpo" },
  domain_auto_renewal_disabled: { icon: ShieldOff, color: "text-red-600", label: "teve a renovação automática desativada" },
};

const DEFAULT_EVENT_META = { icon: PlusCircle, color: "text-muted-foreground", label: "" };

function formatBytes(bytes: number | null) {
  if (bytes === null || bytes === undefined) return "—";
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}

function GithubStatusBadge({
  site,
}: {
  site: { github_sync_status: string | null; github_repo_owner: string | null; github_repo_name: string | null };
}) {
  const repoUrl =
    site.github_repo_owner && site.github_repo_name
      ? `https://github.com/${site.github_repo_owner}/${site.github_repo_name}`
      : null;

  const badge = (() => {
    switch (site.github_sync_status) {
      case "synced":
        return (
          <Badge variant="outline" className="gap-1 text-green-600 border-green-500/30 bg-green-500/10">
            <CheckCircle2 className="h-3 w-3" /> Atualizado
          </Badge>
        );
      case "outdated":
        return (
          <Badge variant="outline" className="gap-1 text-orange-600 border-orange-500/30 bg-orange-500/10">
            <XCircle className="h-3 w-3" /> Desatualizado
          </Badge>
        );
      case "source_only":
        return (
          <Badge variant="outline" className="gap-1 text-blue-600 border-blue-500/30 bg-blue-500/10">
            <Code className="h-3 w-3" /> Código-fonte
          </Badge>
        );
      case "render_required":
        return (
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            <Code className="h-3 w-3" /> Requer JS p/ checar
          </Badge>
        );
      case "no_live_site":
        return (
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            <Github className="h-3 w-3" /> Só backup
          </Badge>
        );
      case "site_unreachable":
        return (
          <Badge variant="outline" className="gap-1 text-red-600 border-red-500/30 bg-red-500/10">
            <AlertTriangle className="h-3 w-3" /> Site fora do ar
          </Badge>
        );
      case "fetch_error":
        return (
          <Badge variant="outline" className="gap-1 text-red-600 border-red-500/30 bg-red-500/10">
            <XCircle className="h-3 w-3" /> Erro ao checar
          </Badge>
        );
      case "no_match":
        return (
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            Sem repositório
          </Badge>
        );
      case "internal":
        return (
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            Domínio interno
          </Badge>
        );
      default:
        return <span className="text-muted-foreground text-xs">—</span>;
    }
  })();

  if (!repoUrl) return badge;
  return (
    <a href={repoUrl} target="_blank" rel="noreferrer" className="hover:opacity-80">
      {badge}
    </a>
  );
}

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function whatsappLink(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `https://wa.me/${digits.length <= 11 ? "55" : ""}${digits}`;
}

function ExpiryBadge({ days }: { days: number }) {
  if (days <= 15) {
    return <Badge className="bg-red-600 hover:bg-red-600">Vence em {days} dia{days === 1 ? "" : "s"}</Badge>;
  }
  if (days <= 30) {
    return (
      <Badge variant="outline" className="text-amber-600 border-amber-500/30 bg-amber-500/10">
        Vence em {days} dias
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Vence em {days} dias
    </Badge>
  );
}

function PaginationFooter({
  currentPage,
  totalPages,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
}: {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  if (totalItems === 0) return null;
  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-4 border-t mt-4">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          Mostrando {(currentPage - 1) * pageSize + 1}–
          {Math.min(currentPage * pageSize, totalItems)} de {totalItems}
        </span>
        <div className="flex items-center gap-1.5">
          <span>por página:</span>
          <Select
            value={pageSize.toString()}
            onValueChange={(v) => onPageSizeChange(parseInt(v))}
          >
            <SelectTrigger className="h-7 w-16 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={size.toString()}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs text-muted-foreground">
          Página {currentPage} de {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(currentPage + 1)}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return `há ${days} d`;
}

export default function HostingMonitor() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncingExpiry, setSyncingExpiry] = useState(false);
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [openFromDate, setOpenFromDate] = useState(false);
  const [openToDate, setOpenToDate] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [problemPage, setProblemPage] = useState(1);
  const [problemPageSize, setProblemPageSize] = useState(25);
  const [excludedPage, setExcludedPage] = useState(1);
  const [excludedPageSize, setExcludedPageSize] = useState(25);

  const { data: plans, isLoading: loadingPlans } = useQuery({
    queryKey: ["hosting_plans"],
    queryFn: async () => {
      const { data, error } = await supabase.from("hosting_plans").select("*").order("order_id");
      if (error) throw error;
      return data;
    },
  });

  const { data: websites, isLoading: loadingWebsites } = useQuery({
    queryKey: ["hosting_websites"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("hosting_websites")
        .select("*, projects:linked_project_id (id, client_name, project_link, telefone)")
        .order("last_seen_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: events, isLoading: loadingEvents } = useQuery({
    queryKey: ["hosting_events"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("hosting_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  });

  const filteredWebsites = useMemo(() => {
    if (!websites) return [];
    const term = search.trim().toLowerCase();

    return websites.filter((w) => {
      if (term && !w.domain.toLowerCase().includes(term)) return false;

      const effectivePlatform = w.is_decommissioned ? "no_hosting" : w.deleted_at ? "vps" : w.platform;
      if (platformFilter !== "all" && effectivePlatform !== platformFilter) return false;

      if (statusFilter !== "all") {
        const status = w.is_decommissioned
          ? "no_hosting"
          : w.deleted_at
          ? "vps"
          : w.panel_state === "offline"
          ? "offline"
          : w.is_placeholder
          ? "placeholder"
          : "active";
        if (status !== statusFilter) return false;
      }

      const firstSeen = new Date(w.first_seen_at);
      if (dateFrom && firstSeen < dateFrom) return false;
      if (dateTo) {
        const endOfDay = new Date(dateTo);
        endOfDay.setHours(23, 59, 59, 999);
        if (firstSeen > endOfDay) return false;
      }

      return true;
    });
  }, [websites, search, platformFilter, statusFilter, dateFrom, dateTo]);

  const vpsMigratedCount = websites?.filter((w) => w.deleted_at && !w.is_decommissioned).length ?? 0;
  const noHostingSites = useMemo(() => {
    const list = websites ?? [];
    // Um domínio pode ter mais de uma linha (uma por order_id da Hostinger) quando
    // migra de plano - a linha antiga fica "is_decommissioned" mesmo o domínio
    // continuando no ar sob outro plano. Não mostra como "sem hospedagem" se existir
    // outra linha do mesmo domínio ativa (deleted_at null).
    const activeDomains = new Set(list.filter((w) => !w.deleted_at).map((w) => w.domain.toLowerCase()));
    return list.filter((w) => w.is_decommissioned && !activeDomains.has(w.domain.toLowerCase()));
  }, [websites]);
  const needsClientActionSites = useMemo(
    () => (websites ?? []).filter((w) => w.needs_client_action),
    [websites]
  );
  // Site "sem hospedagem" já é um caso resolvido/conhecido - excluído de
  // propósito da Hostinger (cancelamento, migração pro Wix do cliente etc.),
  // com backup guardado. Não é algo que precise de ação HOJE, ao contrário de
  // needs_client_action (DNS quebrado, domínio vencendo). Por isso não entra
  // na contagem vermelha da aba "Fora do ar" - só o que realmente precisa de
  // atenção conta aqui.
  const foraDoArCount = needsClientActionSites.length;

  const problemTotalPages = Math.max(1, Math.ceil(needsClientActionSites.length / problemPageSize));
  const problemCurrentPage = Math.min(problemPage, problemTotalPages);
  const paginatedProblemSites = useMemo(
    () => needsClientActionSites.slice((problemCurrentPage - 1) * problemPageSize, problemCurrentPage * problemPageSize),
    [needsClientActionSites, problemCurrentPage, problemPageSize]
  );

  const excludedTotalPages = Math.max(1, Math.ceil(noHostingSites.length / excludedPageSize));
  const excludedCurrentPage = Math.min(excludedPage, excludedTotalPages);
  const paginatedExcludedSites = useMemo(
    () => noHostingSites.slice((excludedCurrentPage - 1) * excludedPageSize, excludedCurrentPage * excludedPageSize),
    [noHostingSites, excludedCurrentPage, excludedPageSize]
  );

  // Domínios com data de expiração conhecida (via RDAP do registro.br, ver
  // domain-expiry-sync) que vencem dentro de 60 dias e ainda não venceram -
  // os já vencidos aparecem em "Fora do ar", aqui é só o aviso prévio pra dar
  // tempo de cobrar o cliente antes do domínio cair de vez. Só entram os
  // domínios EXTERNOS (domain_registered_by_us === false, cruzado contra o
  // portfólio da nossa própria conta Hostinger) - o que a gente mesmo compra
  // fica com renovação automática habilitada por política e só é desativada
  // no processo de cancelamento do cliente, então não tem por que alertar.
  // Domínio ainda não classificado (null) fica de fora até o próximo ciclo
  // do domain-expiry-sync, pra não arriscar mostrar um domínio nosso à toa.
  const expiringSoonSites = useMemo(() => {
    const list = websites ?? [];
    const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
    return list
      .filter((w) => {
        if (!w.domain_expires_at || w.is_decommissioned || w.domain_registered_by_us !== false) return false;
        const msUntil = new Date(w.domain_expires_at).getTime() - Date.now();
        return msUntil > 0 && msUntil <= SIXTY_DAYS_MS;
      })
      .sort((a, b) => new Date(a.domain_expires_at!).getTime() - new Date(b.domain_expires_at!).getTime());
  }, [websites]);

  // Um domínio pode ter mais de uma linha (uma por order_id) - mostra uma vez só.
  const mailAlertSites = useMemo(() => {
    const seen = new Set<string>();
    return (websites ?? []).filter((w) => {
      if (w.mail_dns_status !== "lost" && w.mail_dns_status !== "changed") return false;
      const key = w.domain.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }) as unknown as MailDnsAlertSite[];
  }, [websites]);

  const totalPages = Math.max(1, Math.ceil(filteredWebsites.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paginatedWebsites = useMemo(
    () => filteredWebsites.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filteredWebsites, currentPage, pageSize]
  );

  const hasActiveFilters =
    !!search || platformFilter !== "all" || statusFilter !== "all" || !!dateFrom || !!dateTo;

  const resetFilters = () => {
    setSearch("");
    setPlatformFilter("all");
    setStatusFilter("all");
    setDateFrom(undefined);
    setDateTo(undefined);
    setPage(1);
  };

  const lastSyncedAt = plans?.reduce<string | null>((latest, p) => {
    if (!p.last_synced_at) return latest;
    if (!latest || new Date(p.last_synced_at) > new Date(latest)) return p.last_synced_at;
    return latest;
  }, null);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const response = await supabase.functions.invoke("hosting-sync", { body: {} });
      if (response.error) {
        const message = await getFunctionErrorMessage(response.error, "Erro ao sincronizar");
        throw new Error(message);
      }
      const result = response.data;

      // hosting-sync só puxa planos/sites do painel da Hostinger - quem testa
      // se o site está no ar é o github-sync. Recheca na hora só os que estão
      // em "Fora do ar", pra quem corrigiu um domínio ver a lista atualizar.
      // Falha aqui não invalida a sincronização com a Hostinger que já deu certo.
      const recheck = await supabase.functions.invoke("github-sync", { body: { only_flagged: true } });
      const recheckSummary = recheck.error
        ? " Não foi possível rechecar os sites fora do ar agora."
        : ` ${recheck.data?.sites_checked ?? 0} site(s) fora do ar rechecado(s), ${recheck.data?.needs_client_action ?? 0} continua(m) com problema.`;

      toast({
        title: "Sincronização concluída",
        description: `${result.created?.length ?? 0} site(s) novo(s), ${result.deleted?.length ?? 0} removido(s).${recheckSummary}`,
      });
      queryClient.invalidateQueries({ queryKey: ["hosting_plans"] });
      queryClient.invalidateQueries({ queryKey: ["hosting_websites"] });
      queryClient.invalidateQueries({ queryKey: ["hosting_events"] });
    } catch (error) {
      console.error("Erro ao sincronizar hospedagem:", error);
      toast({
        title: "Erro",
        description: error instanceof Error ? error.message : "Não foi possível sincronizar.",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleExpirySync = async () => {
    setSyncingExpiry(true);
    try {
      const response = await supabase.functions.invoke("domain-expiry-sync", { body: {} });
      if (response.error) {
        const message = await getFunctionErrorMessage(response.error, "Erro ao checar vencimentos");
        throw new Error(message);
      }
      const result = response.data;
      toast({
        title: "Checagem de vencimento concluída",
        description: `${result.checked ?? 0} domínio(s) consultado(s) no registro.br, ${result.expiring_soon_60d ?? 0} vencendo em até 60 dias.`,
      });
      queryClient.invalidateQueries({ queryKey: ["hosting_websites"] });
    } catch (error) {
      console.error("Erro ao checar vencimento de domínios:", error);
      toast({
        title: "Erro",
        description: error instanceof Error ? error.message : "Não foi possível checar os vencimentos.",
        variant: "destructive",
      });
    } finally {
      setSyncingExpiry(false);
    }
  };

  return (
    <PageLayout
      title="Hospedagem"
      actions={
        <Button size="sm" onClick={handleSync} disabled={syncing}>
          <RefreshCw className={`h-4 w-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
          Sincronizar agora
        </Button>
      }
    >
      <div className="space-y-6">
        {lastSyncedAt && (
          <p className="text-xs text-muted-foreground">
            Última sincronização: {new Date(lastSyncedAt).toLocaleString("pt-BR")}
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="shadow-sm border-amber-500/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Server className="h-4 w-4 text-amber-600" />
                  VPS Hestia
                </span>
                <Badge variant="outline" className="text-amber-600 border-amber-500/30 bg-amber-500/10">
                  76.13.174.32
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Globe className="h-3.5 w-3.5" /> Sites migrados
                </span>
                <span className="font-medium">{vpsMigratedCount}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Sites que saíram da Hostinger e passaram a ser hospedados na nossa própria VPS (HestiaCP).
              </p>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <XCircle className="h-4 w-4 text-muted-foreground" />
                  Excluídos
                </span>
                <Badge variant="outline" className="gap-1 text-muted-foreground">
                  <Github className="h-3 w-3" />
                  Backup no GitHub
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Globe className="h-3.5 w-3.5" /> Sites excluídos
                </span>
                <span className="font-medium">{noHostingSites.length}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Saíram da Hostinger e não foram pra VPS — cancelamento ou outro motivo conhecido, só existe backup
                do código no GitHub. Não precisa de ação.
              </p>
            </CardContent>
          </Card>

          {loadingPlans && <p className="text-sm text-muted-foreground">Carregando planos...</p>}
          {plans?.map((plan) => (
            <Card key={plan.order_id} className="shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center justify-between">
                  <span>{plan.plan_name}</span>
                  <Badge variant="outline">{plan.platform === "h5g" ? "Agency" : "Cloud"}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <Globe className="h-3.5 w-3.5" /> Sites
                    </span>
                    <span className="font-medium">
                      {plan.site_count}
                      {plan.site_limit ? ` / ${plan.site_limit}` : " (sem limite)"}
                    </span>
                  </div>
                  {plan.site_limit && (
                    <Progress value={(plan.site_count / plan.site_limit) * 100} />
                  )}
                </div>
                {plan.disk_bytes_limit && (
                  <div>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <HardDrive className="h-3.5 w-3.5" /> Disco
                      </span>
                      <span className="font-medium">
                        {formatBytes(plan.disk_bytes_used)} / {formatBytes(plan.disk_bytes_limit)}
                      </span>
                    </div>
                    <Progress
                      value={((plan.disk_bytes_used ?? 0) / plan.disk_bytes_limit) * 100}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
          {!loadingPlans && (!plans || plans.length === 0) && (
            <AnalyticsCard
              title="Nenhum dado ainda"
              value="—"
              description='Clique em "Sincronizar agora" para buscar os dados da Hostinger pela primeira vez.'
            />
          )}
        </div>

        <Tabs defaultValue="sites">
          <TabsList>
            <TabsTrigger value="sites">Sites</TabsTrigger>
            <TabsTrigger value="historico">Histórico</TabsTrigger>
            <TabsTrigger value="fora-do-ar" className="gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
              Fora do ar
              {foraDoArCount > 0 && (
                <Badge className="bg-red-600 hover:bg-red-600 h-5 px-1.5">{foraDoArCount}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="email" className="gap-1.5">
              <Mail className="h-3.5 w-3.5 text-red-600" />
              E-mail
              {mailAlertSites.length > 0 && (
                <Badge className="bg-red-600 hover:bg-red-600 h-5 px-1.5">{mailAlertSites.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="vencendo" className="gap-1.5">
              <CalendarClock className="h-3.5 w-3.5 text-amber-600" />
              Vencendo
              {expiringSoonSites.length > 0 && (
                <Badge className="bg-amber-500 hover:bg-amber-500 h-5 px-1.5">{expiringSoonSites.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="sites">
            <Card>
              <CardHeader className="gap-3">
                <CardTitle>Sites hospedados</CardTitle>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1.5 min-w-[180px]">
                    <label className="text-xs font-medium text-muted-foreground">Buscar domínio</label>
                    <Input
                      placeholder="ex: meusite.com.br"
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setPage(1);
                      }}
                      className="h-8 text-xs"
                    />
                  </div>

                  <div className="space-y-1.5 min-w-[160px]">
                    <label className="text-xs font-medium text-muted-foreground">Plataforma</label>
                    <Select
                      value={platformFilter}
                      onValueChange={(v) => {
                        setPlatformFilter(v);
                        setPage(1);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todas</SelectItem>
                        <SelectItem value="h5g">Agency Growth</SelectItem>
                        <SelectItem value="cloudlinux">Cloud Professional</SelectItem>
                        <SelectItem value="vps">VPS (Hestia)</SelectItem>
                        <SelectItem value="no_hosting">Excluído</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5 min-w-[140px]">
                    <label className="text-xs font-medium text-muted-foreground">Status</label>
                    <Select
                      value={statusFilter}
                      onValueChange={(v) => {
                        setStatusFilter(v);
                        setPage(1);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todos</SelectItem>
                        <SelectItem value="active">Ativo (Hostinger)</SelectItem>
                        <SelectItem value="vps">Migrado p/ VPS</SelectItem>
                        <SelectItem value="no_hosting">Excluído</SelectItem>
                        <SelectItem value="offline">Fora do ar</SelectItem>
                        <SelectItem value="placeholder">Placeholder</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Criado de</label>
                    <Popover open={openFromDate} onOpenChange={setOpenFromDate}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="h-8 text-xs font-normal w-[130px] justify-start">
                          <CalendarDays className="h-3 w-3 mr-1.5 text-muted-foreground" />
                          {dateFrom ? format(dateFrom, "dd/MM/yy") : "Selecione"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={dateFrom}
                          onSelect={(date) => {
                            setDateFrom(date);
                            setOpenFromDate(false);
                            setPage(1);
                          }}
                          locale={ptBR}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">até</label>
                    <Popover open={openToDate} onOpenChange={setOpenToDate}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="h-8 text-xs font-normal w-[130px] justify-start">
                          <CalendarDays className="h-3 w-3 mr-1.5 text-muted-foreground" />
                          {dateTo ? format(dateTo, "dd/MM/yy") : "Selecione"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={dateTo}
                          onSelect={(date) => {
                            setDateTo(date);
                            setOpenToDate(false);
                            setPage(1);
                          }}
                          locale={ptBR}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                  </div>

                  {hasActiveFilters && (
                    <Button variant="ghost" size="sm" onClick={resetFilters} className="h-8 text-xs text-muted-foreground">
                      <X className="h-3 w-3 mr-1" />
                      Limpar filtros
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {loadingWebsites ? (
                  <div className="flex justify-center py-8">
                    <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
                  </div>
                ) : filteredWebsites.length > 0 ? (
                  <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Domínio</TableHead>
                        <TableHead>Plataforma</TableHead>
                        <TableHead>Projeto vinculado</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>GitHub</TableHead>
                        <TableHead>Visto por último</TableHead>
                        <TableHead className="w-10"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedWebsites.map((site) => (
                        <TableRow key={site.id}>
                          <TableCell className="font-medium">{site.domain}</TableCell>
                          <TableCell>
                            {site.is_decommissioned ? (
                              <Badge variant="outline" className="gap-1 text-muted-foreground border-muted-foreground/30 bg-muted">
                                <XCircle className="h-3 w-3" />
                                Excluído
                              </Badge>
                            ) : site.deleted_at ? (
                              <Badge variant="outline" className="gap-1 text-amber-600 border-amber-500/30 bg-amber-500/10">
                                <Server className="h-3 w-3" />
                                VPS (Hestia)
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-purple-600 border-purple-500/30 bg-purple-500/10">
                                {site.platform === "h5g" ? "Agency Growth" : "Cloud Professional"}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            {site.projects ? (
                              <Link to={`/projeto/${site.projects.id}`} className="text-primary hover:underline">
                                {site.projects.client_name}
                              </Link>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {site.is_decommissioned ? (
                              <Badge variant="secondary" className="gap-1">
                                <XCircle className="h-3 w-3" />
                                Excluído
                              </Badge>
                            ) : site.deleted_at ? (
                              <Badge className="bg-amber-500">Migrado p/ VPS</Badge>
                            ) : site.panel_state === "offline" ? (
                              <Badge className="bg-orange-500">Fora do ar</Badge>
                            ) : site.is_placeholder ? (
                              <Badge variant="secondary">Placeholder</Badge>
                            ) : (
                              <Badge className="bg-green-500">Ativo</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <GithubStatusBadge site={site} />
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {timeAgo(site.last_seen_at)}
                          </TableCell>
                          <TableCell>
                            <WebsiteRowActions site={site} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>

                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-4 border-t mt-4">
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>
                        Mostrando {(currentPage - 1) * pageSize + 1}–
                        {Math.min(currentPage * pageSize, filteredWebsites.length)} de {filteredWebsites.length}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span>por página:</span>
                        <Select
                          value={pageSize.toString()}
                          onValueChange={(v) => {
                            setPageSize(parseInt(v));
                            setPage(1);
                          }}
                        >
                          <SelectTrigger className="h-7 w-16 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PAGE_SIZE_OPTIONS.map((size) => (
                              <SelectItem key={size} value={size.toString()}>
                                {size}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2"
                        disabled={currentPage <= 1}
                        onClick={() => setPage(currentPage - 1)}
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        Página {currentPage} de {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2"
                        disabled={currentPage >= totalPages}
                        onClick={() => setPage(currentPage + 1)}
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  </>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    Nenhum site encontrado.
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="historico">
            <Card>
              <CardHeader>
                <CardTitle>Histórico de mudanças</CardTitle>
              </CardHeader>
              <CardContent>
                {loadingEvents ? (
                  <div className="flex justify-center py-8">
                    <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
                  </div>
                ) : events && events.length > 0 ? (
                  <div className="space-y-2">
                    {events.map((event) => {
                      const meta = EVENT_META[event.event_type] ?? DEFAULT_EVENT_META;
                      const Icon = meta.icon;
                      return (
                        <div
                          key={event.id}
                          className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors"
                        >
                          <Icon className={`h-4 w-4 flex-shrink-0 ${meta.color}`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {event.domain} <span className="text-muted-foreground font-normal">{meta.label}</span>
                            </p>
                          </div>
                          <span className="text-[11px] text-muted-foreground flex-shrink-0">
                            {timeAgo(event.created_at)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    Nenhum evento registrado ainda.
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="fora-do-ar" className="space-y-4">
            <Card className="border-amber-500/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-1.5 text-amber-600">
                  <AlertTriangle className="h-4 w-4" />
                  Domínio com problema de DNS ({needsClientActionSites.length})
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  O site está provisionado corretamente na nossa hospedagem, mas o domínio ainda aponta pra outro
                  lugar (nameservers desatualizados) — quem responde é a página padrão do outro provedor. Só o dono
                  do domínio pode corrigir isso repontando o DNS.
                </p>
              </CardHeader>
              <CardContent className="space-y-1">
                {needsClientActionSites.length > 0 ? (
                  <>
                    {paginatedProblemSites.map((site) => (
                      <div
                        key={site.id}
                        className="flex items-center justify-between gap-3 py-2 border-b last:border-0"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium truncate">{site.domain}</p>
                            <Badge variant="outline" className="text-amber-600 border-amber-500/30 bg-amber-500/10 shrink-0">
                              Ação do cliente
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap mt-0.5">
                            {site.projects ? (
                              <Link
                                to={`/projeto/${site.projects.id}`}
                                className="text-xs text-primary hover:underline"
                              >
                                {site.projects.client_name}
                              </Link>
                            ) : (
                              <span className="text-xs text-muted-foreground">Sem projeto vinculado</span>
                            )}
                          </div>
                          {site.client_action_note && (
                            <p className="text-xs text-muted-foreground mt-0.5">{site.client_action_note}</p>
                          )}
                        </div>
                        <WebsiteRowActions site={site} />
                      </div>
                    ))}
                    <PaginationFooter
                      currentPage={problemCurrentPage}
                      totalPages={problemTotalPages}
                      pageSize={problemPageSize}
                      totalItems={needsClientActionSites.length}
                      onPageChange={setProblemPage}
                      onPageSizeChange={(size) => {
                        setProblemPageSize(size);
                        setProblemPage(1);
                      }}
                    />
                  </>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    Nenhum domínio com problema de DNS detectado no momento.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-1.5 text-muted-foreground">
                  <XCircle className="h-4 w-4" />
                  Sites excluídos ({noHostingSites.length})
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Caso já resolvido/conhecido: saíram da Hostinger e da VPS por cancelamento do serviço, migração
                  do cliente pra outro provedor, ou outro motivo — só existe backup local. Não conta na contagem de
                  "Fora do ar" porque não precisa de nenhuma ação agora. Vincule a um projeto pra manter o histórico.
                </p>
              </CardHeader>
              <CardContent className="space-y-1">
                {noHostingSites.length > 0 ? (
                  <>
                    {paginatedExcludedSites.map((site) => (
                      <div
                        key={site.id}
                        className="flex items-center justify-between gap-3 py-2 border-b last:border-0"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{site.domain}</p>
                          <div className="flex items-center gap-2 flex-wrap">
                            {site.projects ? (
                              <Link
                                to={`/projeto/${site.projects.id}`}
                                className="text-xs text-primary hover:underline"
                              >
                                {site.projects.client_name}
                              </Link>
                            ) : (
                              <span className="text-xs text-muted-foreground">Sem projeto vinculado</span>
                            )}
                            {(site.projects?.project_link || site.github_backup_url) && (
                              <>
                                <span className="text-xs text-muted-foreground">·</span>
                                <a
                                  href={site.projects?.project_link || site.github_backup_url || undefined}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-xs text-muted-foreground hover:text-primary hover:underline flex items-center gap-1"
                                >
                                  <Github className="h-3 w-3" /> Backup
                                </a>
                              </>
                            )}
                          </div>
                        </div>
                        <WebsiteRowActions site={site} />
                      </div>
                    ))}
                    <PaginationFooter
                      currentPage={excludedCurrentPage}
                      totalPages={excludedTotalPages}
                      pageSize={excludedPageSize}
                      totalItems={noHostingSites.length}
                      onPageChange={setExcludedPage}
                      onPageSizeChange={(size) => {
                        setExcludedPageSize(size);
                        setExcludedPage(1);
                      }}
                    />
                  </>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    Nenhum site sem hospedagem no momento.
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="email" className="space-y-4">
            <MailDnsAlerts sites={mailAlertSites} />
          </TabsContent>

          <TabsContent value="vencendo" className="space-y-4">
            <Card className="border-amber-500/30">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-1.5 text-amber-600">
                    <CalendarClock className="h-4 w-4" />
                    Domínios vencendo em até 60 dias ({expiringSoonSites.length})
                  </CardTitle>
                  <Button size="sm" variant="outline" onClick={handleExpirySync} disabled={syncingExpiry}>
                    <RefreshCw className={`h-3.5 w-3.5 mr-1 ${syncingExpiry ? "animate-spin" : ""}`} />
                    Checar vencimentos agora
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Só domínios externos: registrados pelo próprio cliente (em outro registrador, ou numa conta
                  Hostinger separada da nossa) — a gente não controla a renovação deles, só a hospedagem. Domínio
                  que compramos na nossa própria conta Hostinger fica de fora daqui, porque já tem renovação
                  automática habilitada por política. Data consultada direto no registro.br (RDAP), reconferida por
                  rodízio ao longo das semanas.
                </p>
              </CardHeader>
              <CardContent className="space-y-1">
                {expiringSoonSites.length > 0 ? (
                  expiringSoonSites.map((site) => {
                    const phone = site.projects?.telefone;
                    return (
                      <div
                        key={site.id}
                        className="flex items-center justify-between gap-3 py-2 border-b last:border-0"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium truncate">{site.domain}</p>
                            <ExpiryBadge days={daysUntil(site.domain_expires_at!)} />
                            {site.domain_registry_status === "inactive" && (
                              <Badge variant="outline" className="text-red-600 border-red-500/30 bg-red-500/10 shrink-0">
                                Pendência no registro.br
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-wrap mt-0.5">
                            {site.projects ? (
                              <Link
                                to={`/projeto/${site.projects.id}`}
                                className="text-xs text-primary hover:underline"
                              >
                                {site.projects.client_name}
                              </Link>
                            ) : (
                              <span className="text-xs text-muted-foreground">Sem projeto vinculado</span>
                            )}
                            {phone && (
                              <>
                                <span className="text-xs text-muted-foreground">·</span>
                                <a
                                  href={whatsappLink(phone)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-xs text-green-600 hover:underline flex items-center gap-1"
                                >
                                  <Phone className="h-3 w-3" /> Chamar no WhatsApp
                                </a>
                              </>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Vence em {new Date(site.domain_expires_at!).toLocaleDateString("pt-BR", { timeZone: "UTC" })}
                          </p>
                        </div>
                        <WebsiteRowActions site={site} />
                      </div>
                    );
                  })
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    Nenhum domínio vencendo nos próximos 60 dias.
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </PageLayout>
  );
}
