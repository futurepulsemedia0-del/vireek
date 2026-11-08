/** Loads a dependency-free .ts module in plain Node (>=18) by transpiling with the project's `typescript`. */
import fs from 'node:fs';
import ts from 'typescript';

export async function loadTs(file) {
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputText).toString('base64')}`);
}
