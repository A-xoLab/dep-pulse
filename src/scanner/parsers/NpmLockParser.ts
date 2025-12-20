import * as fs from 'node:fs/promises';
import { type Dependency, DepPulseError, ErrorCode } from '../../types';
import { Logger } from '../../utils/Logger';

interface PackageLockDependency {
  version?: string;
  dev?: boolean;
  requires?: Record<string, string>;
  dependencies?: Record<string, PackageLockDependency>;
  optionalDependencies?: Record<string, PackageLockDependency>;
}

interface PackageEntry {
  version?: string;
  dev?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PackageLock {
  lockfileVersion?: number;
  packages?: Record<string, PackageEntry>;
  dependencies?: Record<string, PackageLockDependency>;
}

export class NpmLockParser {
  private logger = Logger.getInstance();

  async parse(lockfilePath: string): Promise<Dependency[]> {
    this.logger.info(`Parsing package-lock.json: ${lockfilePath}`);

    try {
      const content = await fs.readFile(lockfilePath, 'utf-8');
      const lockfile = JSON.parse(content) as PackageLock;

      if (!lockfile || typeof lockfile !== 'object') {
        throw new Error('Invalid lockfile format');
      }

      if (lockfile.packages) {
        return this.parseV2(lockfile);
      }

      if (lockfile.dependencies) {
        return this.parseV1(lockfile.dependencies);
      }

      return [];
    } catch (error) {
      if (error instanceof Error) {
        throw new DepPulseError(
          `Failed to parse package-lock.json: ${error.message}`,
          ErrorCode.PARSE_ERROR,
          true
        );
      }
      throw error;
    }
  }

  private parseV2(lockfile: PackageLock): Dependency[] {
    const root = lockfile.packages?.[''] ?? {};
    const seen = new Set<string>();

    const buildFromPackages = (name: string, isDev: boolean, isTransitive: boolean): Dependency => {
      const pkgInfo =
        lockfile.packages?.[`node_modules/${name}`] ??
        lockfile.dependencies?.[name] ??
        ({} as PackageLockDependency);

      const version = pkgInfo.version ?? '0.0.0';
      const dep: Dependency = {
        name,
        version,
        versionConstraint: version,
        resolvedVersion: version,
        isDev,
        isTransitive,
      };

      const key = `${name}@${version}`;
      if (seen.has(key)) {
        return dep;
      }
      seen.add(key);

      const childDeps: Dependency[] = [];
      const addChild = (childName: string) => {
        childDeps.push(buildFromPackages(childName, pkgInfo.dev ?? isDev, true));
      };

      if (pkgInfo.dependencies) {
        for (const childName of Object.keys(pkgInfo.dependencies)) {
          addChild(childName);
        }
      }

      if ((pkgInfo as PackageEntry).devDependencies) {
        for (const childName of Object.keys((pkgInfo as PackageEntry).devDependencies ?? {})) {
          addChild(childName);
        }
      }

      if ((pkgInfo as PackageEntry).optionalDependencies) {
        for (const childName of Object.keys((pkgInfo as PackageEntry).optionalDependencies ?? {})) {
          addChild(childName);
        }
      }

      if (childDeps.length > 0) {
        dep.children = childDeps;
      }

      return dep;
    };

    const dependencies: Dependency[] = [];

    for (const [name] of Object.entries(root.dependencies ?? {})) {
      dependencies.push(buildFromPackages(name, false, false));
    }

    for (const [name] of Object.entries(root.devDependencies ?? {})) {
      dependencies.push(buildFromPackages(name, true, false));
    }

    return dependencies;
  }

  private parseV1(dependencies: Record<string, PackageLockDependency>): Dependency[] {
    const seen = new Set<string>();

    const walk = (
      name: string,
      info: PackageLockDependency,
      isDev: boolean,
      isTransitive: boolean
    ): Dependency => {
      const version = info.version ?? '0.0.0';
      const dep: Dependency = {
        name,
        version,
        versionConstraint: version,
        resolvedVersion: version,
        isDev: info.dev ?? isDev,
        isTransitive,
      };

      const key = `${name}@${version}`;
      if (seen.has(key)) {
        return dep;
      }
      seen.add(key);

      const children: Dependency[] = [];
      const addChild = (childName: string, childInfo: PackageLockDependency) => {
        children.push(walk(childName, childInfo, info.dev ?? isDev, true));
      };

      if (info.dependencies) {
        for (const [childName, childInfo] of Object.entries(info.dependencies)) {
          addChild(childName, childInfo);
        }
      }
      if (info.optionalDependencies) {
        for (const [childName, childInfo] of Object.entries(info.optionalDependencies)) {
          addChild(childName, childInfo);
        }
      }

      if (children.length > 0) {
        dep.children = children;
      }

      return dep;
    };

    const results: Dependency[] = [];
    for (const [name, info] of Object.entries(dependencies)) {
      results.push(walk(name, info, info.dev ?? false, false));
    }

    return results;
  }
}
