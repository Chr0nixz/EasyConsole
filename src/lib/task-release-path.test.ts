import { describe, expect, it } from "vitest";

import {
  mountPathToRemoteStoragePath,
  remoteStorageDirectoryToWorkDirectory,
  remoteStoragePathToMountPath,
  resolveTaskReleaseScriptSelection,
} from "./task-release-path";

describe("task release path helpers", () => {
  it("maps remote storage paths to mounted container paths", () => {
    expect(remoteStoragePathToMountPath("/xutian/project", "/xutian", "/home/ubuntu/xutian")).toBe("/home/ubuntu/xutian/project");
  });

  it("maps selected working directories to container working directories", () => {
    expect(remoteStorageDirectoryToWorkDirectory("/xutian/project/scripts", "/xutian", "/home/ubuntu/xutian")).toBe(
      "/home/ubuntu/xutian/project/scripts",
    );
  });

  it("maps mounted working directories back to remote picker paths", () => {
    expect(mountPathToRemoteStoragePath("/home/ubuntu/xutian/project/scripts", "/xutian", "/home/ubuntu/xutian")).toBe(
      "/xutian/project/scripts",
    );
  });

  it("falls back from /home/ubuntu container paths to remote picker paths", () => {
    expect(mountPathToRemoteStoragePath("/home/ubuntu/shared/project", "/xutian", "/home/ubuntu/xutian")).toBe(
      "/shared/project",
    );
  });

  it("fills work directory and ./ script path when selecting a script directly", () => {
    expect(
      resolveTaskReleaseScriptSelection({
        selectedFilePath: "/xutian/project/scripts/run.sh",
        storagePath: "/xutian",
        mountPath: "/home/ubuntu/xutian",
      }),
    ).toEqual({
      workDirectory: "/home/ubuntu/xutian/project/scripts",
      scriptPath: "./run.sh",
    });
  });

  it("keeps the current work directory and continues the script path after it", () => {
    expect(
      resolveTaskReleaseScriptSelection({
        selectedFilePath: "/xutian/project/scripts/run.sh",
        storagePath: "/xutian",
        mountPath: "/home/ubuntu/xutian",
        currentWorkDirectory: "/home/ubuntu/xutian/project",
      }),
    ).toEqual({
      workDirectory: "/home/ubuntu/xutian/project",
      scriptPath: "./scripts/run.sh",
    });
  });

  it("falls back to /home/ubuntu when the selected file is outside the configured storage path", () => {
    expect(
      resolveTaskReleaseScriptSelection({
        selectedFilePath: "/shared/run.sh",
        storagePath: "/xutian",
        mountPath: "/home/ubuntu/xutian",
      }),
    ).toEqual({
      workDirectory: "/home/ubuntu/shared",
      scriptPath: "./run.sh",
    });
  });
});
