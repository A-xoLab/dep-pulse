import * as fs from 'node:fs/promises';
import { type Dependency, DepPulseError, ErrorCode } from '../../types';
import { Logger } from '../../utils/Logger';

type YarnEntry = {
  name: string;
  version?: string;
  dependencies: Record<string, string>;
};

export class YarnLockParser {
  private logger = Logger.getInstance();

  async parse(lockfilePath: string): Promise<Dependency[]> {
    this.logger.info(`Parsing yarn.lock: ${lockfilePath}`);

    try {
      const content = await fs.readFile(lockfilePath, 'utf-8');
      const entries = this.parseEntries(content);
      const dependencies: Dependency[] = [];
      const dependencyCache = new Map<string, Dependency>();
      const entryIndex = new Map<string, YarnEntry>();

      for (const entry of entries) {
        if (entry.version) {
          entryIndex.set(`${entry.name}@${this.cleanVersion(entry.version)}`, entry);
        }
      }

      const processDependency = (
        name: string,
        version: string | undefined,
        versionConstraint: string,
        isDev: boolean,
        isTransitive: boolean,
        childrenSpec: Record<string, string>
      ): Dependency => {
        if (!version) {
          version = '0.0.0';
        }

        const cleanResolved = this.cleanVersion(version);
        const cacheKey = `${name}@${cleanResolved}`;
        const cached = dependencyCache.get(cacheKey);
        if (cached) {
          return cached;
        }

        const dep: Dependency = {
          name,
          version: cleanResolved,
          versionConstraint,
          resolvedVersion: cleanResolved,
          isDev,
          isTransitive,
        };
        dependencyCache.set(cacheKey, dep);

        const children = Object.entries(childrenSpec).map(([childName, constraint]) => {
          const childResolved = this.cleanVersion(constraint);
          const childEntry = entryIndex.get(`${childName}@${childResolved}`);
          return processDependency(
            childName,
            childResolved,
            constraint,
            isDev,
            true,
            childEntry?.dependencies ?? {}
          );
        });

        if (children.length > 0) {
          dep.children = children;
        }

        return dep;
      };

      for (const entry of entries) {
        // Yarn lock alone doesn't flag dev vs prod; keep existing behavior (all non-dev)
        dependencies.push(
          processDependency(
            entry.name,
            entry.version,
            entry.version ?? '',
            false,
            false,
            entry.dependencies
          )
        );
      }

      return dependencies;
    } catch (error) {
      if (error instanceof Error) {
        throw new DepPulseError(
          `Failed to parse yarn.lock: ${error.message}`,
          ErrorCode.PARSE_ERROR,
          true
        );
      }
      throw error;
    }
  }

  private parseEntries(content: string): YarnEntry[] {
    const lines = content.split('\n');
    const entries: YarnEntry[] = [];

    let current: YarnEntry | null = null;
    let inDeps = false;

    const pushCurrent = () => {
      if (current?.name && current.version) {
        entries.push(current);
      }
      current = null;
      inDeps = false;
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      if (line.trim().length === 0) {
        continue;
      }

      // Entry start: "<specifier>:" (may include multiple specifiers separated by comma)
      if (/^[^\s].*:\s*$/.test(line)) {
        pushCurrent();
        const specifiers = line.replace(/:$/, '').split(',');
        const firstSpecifier = specifiers[0]?.trim().replace(/^"+|"+$/g, '');
        const name = this.extractName(firstSpecifier);
        current = { name, dependencies: {} };
        inDeps = false;
        continue;
      }

      if (!current) {
        continue;
      }

      const trimmed = line.trim();

      if (trimmed.startsWith('version ')) {
        const match = trimmed.match(/version\s+"([^"]+)"/);
        if (match) {
          current.version = match[1];
        }
        inDeps = false;
        continue;
      }

      if (trimmed === 'dependencies:') {
        inDeps = true;
        continue;
      }

      if (inDeps && rawLine[0] !== ' ' && rawLine[0] !== '\t') {
        // dependencies block ended when indentation is removed
        inDeps = false;
      }

      if (inDeps) {
        const depMatch = trimmed.match(/^([^"]+)\s+"([^"]+)"/);
        if (depMatch) {
          const depName = depMatch[1].trim();
          const depRange = depMatch[2];
          current.dependencies[depName] = depRange;
        }
      }
    }

    pushCurrent();
    return entries;
  }

  private extractName(specifier: string): string {
    const atIndex = specifier.lastIndexOf('@');
    if (atIndex <= 0) {
      return specifier;
    }
    return specifier.slice(0, atIndex);
  }

  private cleanVersion(version: string): string {
    return version.replace(/^[\^~>=<]+/, '').trim();
  }
}
