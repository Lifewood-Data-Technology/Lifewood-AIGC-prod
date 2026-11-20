// Test-only loader for rendering client components: resolves extensionless `.tsx` imports and transpiles
// `.tsx` with the project's TypeScript (react-jsx). Plain `.ts` stays with Node's own type stripping.
import { readFile } from "node:fs/promises";
import ts from "typescript";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !/^\.{1,2}\//.test(specifier) || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
    return nextResolve(`${specifier}.tsx`, context);
  }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !url.endsWith(".tsx")) return nextLoad(url, context);
  const source = await readFile(new URL(url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: url,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return { format: "module", source: outputText, shortCircuit: true };
}
