import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { LoadingState } from "./DataState";
import { useI18n } from "../lib/i18n";
import { useAuth } from "../lib/use-auth";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { t } = useI18n();
  const location = useLocation();

  if (!auth.ready) return <LoadingState label={t("login.restoreSession")} />;
  if (!auth.token) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}
