/**
 * Reading configuration in both runtimes the SDK ships into.
 *
 * The keepers and scripts run under Node, where variables live on
 * `process.env`. The apps run under Vite, where they are statically replaced on
 * `import.meta.env` and `process` does not exist at all. Touching the wrong one
 * throws, so every lookup goes through here.
 *
 * Vite only exposes variables prefixed `VITE_`, so each key is looked up under
 * both its bare name and a `VITE_` form.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * `import.meta` with the bundler-injected `env` bag.
 *
 * Declared locally rather than as a global `ImportMeta` augmentation: Vite ships
 * its own `ImportMetaEnv` typing, and a second global declaration collides with
 * it ("all declarations of 'env' must have identical modifiers"), breaking any
 * Vite app that imports this SDK.
 */
type ImportMetaWithEnv = { env?: Record<string, string | undefined> };

const fromProcess = (key: string): string | undefined => {
  const candidate = (globalThis as any)?.process?.env;
  return candidate && typeof candidate === 'object' ? candidate[key] : undefined;
};

/**
 * `import.meta.env`, in the one form every bundler accepts.
 *
 * It must be a plain property access. Assigning `import.meta` to a variable, or
 * optional-chaining on `import.meta` itself, counts as "direct access": webpack
 * cannot statically analyse it, warns, and can leave a construct that throws at
 * run time in a Next bundle. Vite replaces the property access at build time,
 * and outside a bundler the try/catch absorbs it.
 */
const fromImportMeta = (key: string): string | undefined => {
  try {
    // The cast is erased at compile time, so this emits a plain
    // `import.meta.env?.[key]` - property access, which every bundler accepts.
    const value = (import.meta as unknown as ImportMetaWithEnv).env?.[key];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
};

/** First non-empty value for `key`, checking Node then the bundler. */
export const readEnv = (key: string): string | undefined => {
  const viteKey = key.startsWith('VITE_') ? key : `VITE_${key}`;
  for (const candidate of [
    fromProcess(key),
    fromProcess(viteKey),
    fromImportMeta(viteKey),
    fromImportMeta(key),
  ]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
};

export const readEnvOr = (key: string, fallback: string): string => readEnv(key) ?? fallback;
