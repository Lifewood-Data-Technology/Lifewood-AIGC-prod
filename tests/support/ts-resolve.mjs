// Test-only resolver. Application TypeScript uses bundler-style extensionless relative imports,
// which Node's own TypeScript support does not resolve.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !/^\.{1,2}\//.test(specifier) || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
    return nextResolve(`${specifier}.ts`, context);
  }
}
