import React from "react";
import { Server, Cloud, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useHostingLocation } from "@/hooks/useHostingLocation";

interface HostingLocationBadgeProps {
  projectId?: string | null;
  domain?: string | null;
}

export const HostingLocationBadge: React.FC<HostingLocationBadgeProps> = ({ projectId, domain }) => {
  const { status } = useHostingLocation(projectId, domain);

  if (status === "unknown") return null;

  if (status === "loading") {
    return (
      <Badge variant="outline" className="text-xs gap-1 text-muted-foreground border-muted-foreground/30 animate-pulse">
        Verificando hospedagem...
      </Badge>
    );
  }

  if (status === "vps") {
    return (
      <Badge variant="outline" className="text-xs gap-1 text-amber-600 border-amber-500/30 bg-amber-500/10">
        <Server className="h-3 w-3" />
        Hospedado na VPS (Hestia)
      </Badge>
    );
  }

  if (status === "no_hosting") {
    return (
      <Badge variant="outline" className="text-xs gap-1 text-red-600 border-red-500/30 bg-red-500/10">
        <AlertTriangle className="h-3 w-3" />
        Sem hospedagem
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="text-xs gap-1 text-purple-600 border-purple-500/30 bg-purple-500/10">
      <Cloud className="h-3 w-3" />
      Hospedado na Hostinger
    </Badge>
  );
};
