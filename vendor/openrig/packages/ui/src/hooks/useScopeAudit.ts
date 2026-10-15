import { useQuery } from "@tanstack/react-query";

export interface ScopeAuditFinding {
  kind: string;
  severity: "high" | "low" | "info";
  path: string;
  message: string;
  remediation: string;
}

export interface ScopeAuditSliceResult {
  name: string;
  railStatus: "present" | "missing" | "malformed" | "readme-only";
  frontmatterError: string | null;
  findings: ScopeAuditFinding[];
}

export interface ScopeAuditResponse {
  ok: boolean;
  mission: {
    name: string;
    railStatus: "present" | "missing" | "malformed" | "readme-only";
    frontmatterError: string | null;
    findings: ScopeAuditFinding[];
  };
  slices: ScopeAuditSliceResult[];
  totalFindings: number;
}

export function useScopeAudit(missionId: string | null) {
  return useQuery<ScopeAuditResponse>({
    queryKey: ["scope-audit", missionId],
    queryFn: async () => {
      const res = await fetch(`/api/scope/audit?mission=${encodeURIComponent(missionId!)}`);
      if (!res.ok) throw new Error(`scope audit failed: ${res.status}`);
      return res.json();
    },
    enabled: !!missionId,
    staleTime: 30_000,
  });
}
