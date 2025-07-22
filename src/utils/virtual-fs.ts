import { promises as fs } from "fs";
import * as path from "path";

const virtualFileSystem = new Map<string, string>();

export function getVirtualFile(filePath: string): string | undefined {
  return virtualFileSystem.get(path.resolve(filePath));
}

export function setVirtualFile(filePath: string, content: string): void {
  virtualFileSystem.set(path.resolve(filePath), content);
}

export function deleteVirtualFile(filePath: string): void {
  virtualFileSystem.delete(path.resolve(filePath));
}

export function clearVirtualFileSystem(): void {
  virtualFileSystem.clear();
}

export function listVirtualFiles(): string[] {
  return Array.from(virtualFileSystem.keys());
}

export async function fileExists(filePath: string): Promise<boolean> {
  const resolvedPath = path.resolve(filePath);
  if (virtualFileSystem.has(resolvedPath)) {
    return true;
  }
  try {
    await fs.access(resolvedPath);
    return true;
  } catch {
    return false;
  }
}
