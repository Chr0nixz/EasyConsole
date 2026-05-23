import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { LoadingState } from "./DataState";
import { useAuth } from "../lib/use-auth";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();

  if (!auth.ready) return <LoadingState label="正在恢复登录状态" />;
  if (!auth.token) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}
