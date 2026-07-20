import { normalizeStoragePath } from "./remote-storage";

function normalizeContainerPath(path?: string | null) {
  if (!path) return "/";
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  if (!normalized || normalized === ".") return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function trimTrailingSlash(path: string) {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function getParentContainerPath(path: string) {
  const normalized = trimTrailingSlash(normalizeContainerPath(path));
  if (normalized === "/") return "/";
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

function getContainerFileName(path: string) {
  const normalized = trimTrailingSlash(normalizeContainerPath(path));
  return normalized.split("/").filter(Boolean).at(-1) ?? "";
}

function formatScriptRelativePath(filePath: string, workDirectory: string) {
  const normalizedFilePath = trimTrailingSlash(normalizeContainerPath(filePath));
  const normalizedWorkDirectory = trimTrailingSlash(normalizeContainerPath(workDirectory));
  const prefix = normalizedWorkDirectory === "/" ? "/" : `${normalizedWorkDirectory}/`;
  const relativePath = normalizedFilePath.startsWith(prefix)
    ? normalizedFilePath.slice(prefix.length)
    : getContainerFileName(normalizedFilePath);
  return `./${relativePath.replace(/^\.?\//, "")}`;
}

function joinRemoteStoragePath(basePath: string, suffix: string) {
  const normalizedBasePath = trimTrailingSlash(normalizeStoragePath(basePath));
  const normalizedSuffix = suffix.replace(/^\/+/, "");
  if (!normalizedSuffix) return normalizedBasePath || "/";
  return normalizedBasePath === "/" ? `/${normalizedSuffix}` : `${normalizedBasePath}/${normalizedSuffix}`;
}

export function remoteStoragePathToMountPath(remotePath: string, storagePath: string, mountPath: string) {
  const normalizedRemotePath = normalizeStoragePath(remotePath);
  const normalizedStoragePath = trimTrailingSlash(normalizeStoragePath(storagePath));
  const normalizedMountPath = trimTrailingSlash(normalizeContainerPath(mountPath || "/home/ubuntu"));

  if (normalizedStoragePath === "/") {
    const suffix = normalizedRemotePath.replace(/^\/+/, "");
    return suffix ? `${normalizedMountPath}/${suffix}` : normalizedMountPath;
  }

  if (normalizedRemotePath === normalizedStoragePath || normalizedRemotePath.startsWith(`${normalizedStoragePath}/`)) {
    const suffix = normalizedRemotePath.slice(normalizedStoragePath.length).replace(/^\/+/, "");
    return suffix ? `${normalizedMountPath}/${suffix}` : normalizedMountPath;
  }

  const fallbackSuffix = normalizedRemotePath.replace(/^\/+/, "");
  return fallbackSuffix ? `/home/ubuntu/${fallbackSuffix}` : "/home/ubuntu";
}

export function mountPathToRemoteStoragePath(containerPath: string, storagePath: string, mountPath: string) {
  const normalizedContainerPath = trimTrailingSlash(normalizeContainerPath(containerPath));
  const normalizedStoragePath = trimTrailingSlash(normalizeStoragePath(storagePath));
  const normalizedMountPath = trimTrailingSlash(normalizeContainerPath(mountPath || "/home/ubuntu"));

  if (normalizedContainerPath === normalizedMountPath || normalizedContainerPath.startsWith(`${normalizedMountPath}/`)) {
    const suffix = normalizedContainerPath.slice(normalizedMountPath.length).replace(/^\/+/, "");
    return joinRemoteStoragePath(normalizedStoragePath, suffix);
  }

  if (normalizedContainerPath === "/home/ubuntu" || normalizedContainerPath.startsWith("/home/ubuntu/")) {
    return normalizeStoragePath(normalizedContainerPath.slice("/home/ubuntu".length));
  }

  return normalizeStoragePath(containerPath);
}

export function remoteStorageDirectoryToWorkDirectory(remoteDirectoryPath: string, storagePath: string, mountPath: string) {
  return remoteStoragePathToMountPath(remoteDirectoryPath, storagePath, mountPath);
}

export function resolveTaskReleaseScriptSelection({
  selectedFilePath,
  storagePath,
  mountPath,
  currentWorkDirectory,
}: {
  selectedFilePath: string;
  storagePath: string;
  mountPath: string;
  currentWorkDirectory?: string;
}) {
  const mountedFilePath = remoteStoragePathToMountPath(selectedFilePath, storagePath, mountPath);
  const normalizedCurrentWorkDirectory = currentWorkDirectory?.trim()
    ? trimTrailingSlash(normalizeContainerPath(currentWorkDirectory))
    : "";
  const useCurrentWorkDirectory =
    normalizedCurrentWorkDirectory && mountedFilePath.startsWith(`${normalizedCurrentWorkDirectory}/`);
  const workDirectory = useCurrentWorkDirectory ? normalizedCurrentWorkDirectory : getParentContainerPath(mountedFilePath);
  return {
    workDirectory,
    scriptPath: formatScriptRelativePath(mountedFilePath, workDirectory),
  };
}
