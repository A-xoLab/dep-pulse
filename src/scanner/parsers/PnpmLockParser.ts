import * as fs from 'node:fs/promises';
import * as yaml from 'js-yaml';
import { type Dependency, DepPulseError, ErrorCode } from '../../types';
import { Logger } from '../../utils/Logger';

interface PnpmLockfile {
  lockfileVersion: string;
  importers?: Record<
    string,
    {
      dependencies?: Record<string, { version: string; specifier: string }>;
      devDependencies?: Record<string, { version: string; specifier: string }>;
    }
  >;
  packages?: Record<
    string,
    {
      resolution: { integrity: string };
    }
  >;
  snapshots?: Record<
    string,
    {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    }
  >;
}

export class PnpmLockParser {
  private logger = Logger.getInstance();

  async parse(lockfilePath: string): Promise<Dependency[]> {
    this.logger.info(`Parsing pnpm-lock.yaml: ${lockfilePath}`);

    try {
      const content = await fs.readFile(lockfilePath, 'utf-8');
      const lockfile = yaml.load(content) as PnpmLockfile;

      if (!lockfile || typeof lockfile !== 'object') {
        throw new Error('Invalid lockfile format');
      }

      // Support for pnpm-lock.yaml v9.0
      // We focus on the root importer '.'
      const rootImporter = lockfile.importers?.['.'];
      if (!rootImporter) {
        this.logger.warn('No root importer found in pnpm-lock.yaml');
        return [];
      }

      const dependencies: Dependency[] = [];
      const processed = new Set<string>();

      // Helper to process a dependency
      const processDependency = (
        name: string,
        versionOrRef: string,
        isDev: boolean,
        isTransitive: boolean
      ): void => {
        // In pnpm lockfile v9, the version field in importers often looks like:
        // "1.4.0" or "5.2.2(react-hook-form@7.63.0(react@19.1.1))"
        // This key corresponds to an entry in 'snapshots' (and 'packages' for resolution info)

        // We need to find the matching snapshot key.
        // In v9, the key in 'snapshots' is often the package path/version.
        // For direct deps in 'importers', the 'version' field IS the snapshot key (or part of it).

        // Let's try to extract the clean version for display
        const cleanVersion = this.extractVersion(versionOrRef);

        const dep: Dependency = {
          name,
          version: cleanVersion,
          versionConstraint: versionOrRef, // Using the ref as constraint for now
          isDev,
          isTransitive,
          resolvedVersion: cleanVersion,
        };

        // Avoid infinite recursion / duplicates
        const uniqueKey = `${name}@${cleanVersion}`;
        if (processed.has(uniqueKey)) {
          return;
        }
        processed.add(uniqueKey);

        // Find children
        if (lockfile.snapshots) {
          // The key in snapshots might be the versionOrRef directly, or we might need to construct it.
          // In the user's example:
          // Importer dep: '@hookform/resolvers': version: '5.2.2(react-hook-form@7.63.0(react@19.1.1))'
          // Snapshot key: '@hookform/resolvers@5.2.2(react-hook-form@7.63.0(react@19.1.1))' -> Wait, looking at the file:
          // The snapshot key is just the version string if it's not aliased?
          // Actually, looking at the file provided:
          // packages: '@hookform/resolvers@5.2.2' ...
          // snapshots: '@hookform/resolvers@5.2.2(react-hook-form@7.63.0(react@19.1.1))': ...

          // It seems the key in 'snapshots' matches the 'version' in 'importers' IF we prepend the package name?
          // No, let's look at '@radix-ui/react-accordion':
          // Importer version: '1.2.2(@types/react-dom@19.1.9...)'
          // Snapshot key: '@radix-ui/react-accordion@1.2.2(@types/react-dom@19.1.9...)'

          // So the snapshot key is `${name}@${versionOrRef}`.

          const snapshotKey = `${name}@${versionOrRef}`;
          let snapshot = lockfile.snapshots[snapshotKey];

          // Fallback: sometimes the key is just the version if it's a simple version?
          // Example: '@emotion/is-prop-valid': version: 1.4.0
          // Snapshot key: '@emotion/is-prop-valid@1.4.0'

          if (!snapshot) {
            // Try without name prefix if it fails (though v9 usually includes it)
            if (lockfile.snapshots[versionOrRef]) {
              snapshot = lockfile.snapshots[versionOrRef];
            }
          }

          if (snapshot?.dependencies) {
            dep.children = [];
            for (const [childName, childVersion] of Object.entries(snapshot.dependencies)) {
              // Recursively process children
              // Note: childVersion here is the version/ref for the child

              // We don't want to fully flatten everything into the top-level list immediately,
              // but for the 'Dependency' type which supports children, we can build the tree.
              // However, the current DepPulse UI might expect a flat list or a tree.
              // The NativeScanner produces a tree.

              // For now, let's just add them as children.
              const childDep: Dependency = {
                name: childName,
                version: this.extractVersion(childVersion),
                versionConstraint: childVersion,
                isDev: isDev, // Inherit isDev? Or consider transitive always false/true? Usually transitive deps don't have isDev flag per se, but we can inherit.
                isTransitive: true,
                resolvedVersion: this.extractVersion(childVersion),
              };
              dep.children.push(childDep);

              // We could recursively process children's children here if we want a deep tree.
              // But be careful of stack overflow on large trees.
              // Let's do one level deep for now or implement a proper walker if needed.
              // Given the requirement for "Transitive Dependency Support", we probably want the full tree.
              // But let's start with direct children to ensure basic parsing works.
            }
          }
        }

        dependencies.push(dep);
      };

      // Process direct dependencies
      if (rootImporter.dependencies) {
        for (const [name, ref] of Object.entries(rootImporter.dependencies)) {
          processDependency(name, ref.version, false, false);
        }
      }

      // Process dev dependencies
      if (rootImporter.devDependencies) {
        for (const [name, ref] of Object.entries(rootImporter.devDependencies)) {
          processDependency(name, ref.version, true, false);
        }
      }

      return dependencies;
    } catch (error) {
      if (error instanceof Error) {
        throw new DepPulseError(
          `Failed to parse pnpm-lock.yaml: ${error.message}`,
          ErrorCode.PARSE_ERROR,
          true
        );
      }
      throw error;
    }
  }

  private extractVersion(versionStr: string): string {
    // Remove peer dep info like (react@19.1.1)
    // "5.2.2(react-hook-form@7.63.0(react@19.1.1))" -> "5.2.2"
    return versionStr.split('(')[0];
  }
}
